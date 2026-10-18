import Foundation
import WebKit

// Cancellable native requests shared by foreground Capacitor and the App Intent.
final class PlatformNetworkOperation {
    private let lock = NSLock()
    private var task: URLSessionTask?
    private var stopped = false
    var cancelled: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
    func attach(_ task: URLSessionTask) {
        lock.lock(); self.task = task; let cancel = stopped; lock.unlock()
        if cancel { task.cancel() }
    }
    func cancel() { lock.lock(); stopped = true; let pending = task; lock.unlock(); pending?.cancel() }
}

enum PlatformSessionTransport {
    static let entries = [
        "gradescope": "https://www.gradescope.com/account",
        "blackboard": "https://elearning.shanghaitech.edu.cn:8443/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1",
        "eams": "https://eams.shanghaitech.edu.cn/eams/courseTableForStd.action",
    ]
    private static var stores: [String: WKWebsiteDataStore] = [:]
    static func store(_ provider: String) -> WKWebsiteDataStore {
        if let existing = stores[provider] { return existing }
        let ids = ["gradescope": "96B4CE1A-A16D-48F2-88F4-7D8B1A6D0011",
                   "blackboard": "96B4CE1A-A16D-48F2-88F4-7D8B1A6D0012",
                   "eams": "96B4CE1A-A16D-48F2-88F4-7D8B1A6D0013"]
        let result = WKWebsiteDataStore(forIdentifier: UUID(uuidString: ids[provider]!)!)
        stores[provider] = result
        return result
    }
    private static func error(_ text: String) -> NSError {
        NSError(domain: "PlatformSessions", code: 1, userInfo: [NSLocalizedDescriptionKey: text])
    }
    @discardableResult
    static func request(options: [String: Any], completion: @escaping (Result<[String: Any], Error>) -> Void) -> PlatformNetworkOperation {
        let operation = PlatformNetworkOperation()
        guard let provider = options["provider"] as? String, let entry = entries[provider],
              let expected = URL(string: entry), let raw = options["url"] as? String,
              let url = URL(string: raw), PlatformRequestPolicy.sameOrigin(url, expected) else {
            completion(.failure(error("平台会话不能用于其他站点"))); return operation
        }
        let method = (options["method"] as? String) ?? "GET"
        guard PlatformRequestPolicy.allows(method: method, provider: provider, url: url) else {
            completion(.failure(error("不允许的平台请求方法"))); return operation
        }
        DispatchQueue.main.async {
            guard !operation.cancelled else { completion(.failure(error("同步已取消"))); return }
            let cookieStore = PlatformSessionTransport.store(provider).httpCookieStore
            cookieStore.getAllCookies { cookies in
                let config = URLSessionConfiguration.ephemeral
                config.httpCookieStorage = nil
                config.httpShouldSetCookies = false
                config.urlCache = nil
                config.timeoutIntervalForRequest = min(30, max(1, ((options["timeout"] as? Double) ?? 15000) / 1000))
                var request = URLRequest(url: url)
                request.httpMethod = method
                request.setValue("text/html,application/json", forHTTPHeaderField: "Accept")
                request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
                let applicable = cookies.filter { PlatformRequestPolicy.applicable($0, url: url) }
                for (key, value) in HTTPCookie.requestHeaderFields(with: applicable) {
                    request.setValue(value, forHTTPHeaderField: key)
                }
                if method == "POST" {
                    request.httpBody = (options["body"] as? String)?.data(using: .utf8)
                    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
                }
                let receiver = PlatformPageReceiver(cookieStore: cookieStore, expected: expected) { result in
                    switch result {
                    case .success(let response): completion(.success(response))
                    case .failure(let error): completion(.failure(error))
                    }
                }
                let session = URLSession(configuration: config, delegate: receiver, delegateQueue: nil)
                let task = session.dataTask(with: request)
                operation.attach(task)
                task.resume()
            }
        }
        return operation
    }
}

private final class PlatformPageReceiver: NSObject, URLSessionDataDelegate {
    private let limit = 5 * 1024 * 1024
    private var body = Data()
    private var response: HTTPURLResponse?
    private var failure: String?
    private let cookieStore: WKHTTPCookieStore
    private let expected: URL
    private let completion: (Result<[String: Any], Error>) -> Void
    init(cookieStore: WKHTTPCookieStore, expected: URL, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        self.cookieStore = cookieStore; self.expected = expected; self.completion = completion
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        self.response = response as? HTTPURLResponse
        if response.expectedContentLength > Int64(limit) {
            failure = "平台响应超过 5 MiB 上限"; completionHandler(.cancel)
        } else { completionHandler(.allow) }
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if body.count + data.count > limit { failure = "平台响应超过 5 MiB 上限"; dataTask.cancel() }
        else { body.append(data) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer { session.finishTasksAndInvalidate() }
        if let failure { finishError(failure); return }
        if let error { completion(.failure(error)); return }
        guard let response, let url = response.url else { finishError("平台没有返回有效响应"); return }
        let location = response.value(forHTTPHeaderField: "Location")
        if (300..<400).contains(response.statusCode), let location,
           let target = URL(string: location, relativeTo: url)?.absoluteURL,
           target.scheme != expected.scheme || target.host != expected.host || (target.port ?? 443) != (expected.port ?? 443) {
            finishError("LOGIN_REQUIRED：平台需要重新登录"); return
        }
        guard let text = String(data: body, encoding: .utf8) else { finishError("平台响应不是有效 UTF-8 页面"); return }
        var headers: [String: String] = [:]
        if let location { headers["location"] = location }
        if let contentType = response.value(forHTTPHeaderField: "Content-Type") { headers["content-type"] = contentType }
        let result: [String: Any] = ["status": response.statusCode, "headers": headers, "body": text,
                                   "url": url.absoluteString, "followedRedirects": false]
        let cookieHeaders = response.allHeaderFields.reduce(into: [String: String]()) { result, item in
            if let key = item.key as? String { result[key] = String(describing: item.value) }
        }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: cookieHeaders, for: url)
        DispatchQueue.main.async {
            let group = DispatchGroup()
            for cookie in cookies {
                group.enter(); self.cookieStore.setCookie(cookie) { group.leave() }
            }
            group.notify(queue: .main) { self.completion(.success(result)) }
        }
    }
    private func finishError(_ message: String) {
        completion(.failure(NSError(domain: "PlatformSessions", code: 1,
                                    userInfo: [NSLocalizedDescriptionKey: message])))
    }
}
