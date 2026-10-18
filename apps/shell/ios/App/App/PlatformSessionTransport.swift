import Foundation
import WebKit
import Security

/// Session cookies can disappear when WebKit's process is recreated. Keep an
/// app-only Keychain copy, scoped to this installation and isolated by provider.
enum PlatformSessionCookieVault {
    private static func query(_ provider: String) -> [String: Any] {
        let key = "platform.sessions.installation"
        let installation = UserDefaults.standard.string(forKey: key) ?? UUID().uuidString
        UserDefaults.standard.set(installation, forKey: key)
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: "dev.matrix.shell.platform-cookies",
                kSecAttrAccount as String: installation + "." + provider]
    }
    static func encode(_ cookies: [HTTPCookie]) throws -> Data {
        let rows = cookies.map { cookie in
            var properties = cookie.properties ?? [:]
            // Never restart a relative Max-Age when restoring a saved cookie.
            properties.removeValue(forKey: .maximumAge)
            if let expiry = cookie.expiresDate { properties[.expires] = expiry }
            return properties.reduce(into: [String: Any]()) { row, pair in
                if let url = pair.value as? URL { row[pair.key.rawValue] = url.absoluteString }
                else { row[pair.key.rawValue] = pair.value }
            }
        }
        return try PropertyListSerialization.data(fromPropertyList: rows, format: .binary, options: 0)
    }
    static func decode(_ data: Data, now: Date = Date()) throws -> [HTTPCookie] {
        guard let rows = try PropertyListSerialization.propertyList(from: data, format: nil) as? [[String: Any]] else {
            throw failure(errSecDecode)
        }
        return rows.compactMap { row in
            HTTPCookie(properties: Dictionary(uniqueKeysWithValues: row.map { (HTTPCookiePropertyKey($0.key), $0.value) }))
        }.filter { $0.expiresDate == nil || $0.expiresDate! > now }
    }
    static func save(_ cookies: [HTTPCookie], provider: String) throws {
        let data = try encode(cookies), item = query(provider)
        let status = SecItemUpdate(item as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var added = item
            added[kSecValueData as String] = data
            added[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let result = SecItemAdd(added as CFDictionary, nil)
            guard result == errSecSuccess else { throw failure(result) }
        } else if status != errSecSuccess { throw failure(status) }
    }
    static func load(_ provider: String) throws -> [HTTPCookie] {
        var item = query(provider)
        item[kSecReturnData as String] = true; item[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(item as CFDictionary, &value)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let data = value as? Data else { throw failure(status) }
        return try decode(data)
    }
    static func clear(_ provider: String) throws {
        let status = SecItemDelete(query(provider) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw failure(status) }
    }
    private static func failure(_ code: OSStatus) -> NSError {
        NSError(domain: "PlatformSessionCookieVault", code: Int(code),
                userInfo: [NSLocalizedDescriptionKey: "本机会话安全存储不可用（\(code)）"])
    }
}

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
    // Only counts and HTTP status are recorded; never cookie values or page URLs.
    private static func diagnose(_ provider: String, fields: [String: Any]) {
        let defaults = UserDefaults(suiteName: "group.dev.matrix.shell")
        let key = "ddl.widget.sessionDiagnostics." + provider
        var record = defaults?.dictionary(forKey: key) ?? [:]
        fields.forEach { record[$0.key] = $0.value }
        defaults?.set(record, forKey: key)
    }
    static let entries = [
        "gradescope": "https://www.gradescope.com/account",
        "blackboard": "https://elearning.shanghaitech.edu.cn:8443/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1",
        "eams": "https://eams.shanghaitech.edu.cn/eams/courseTableForStd.action",
    ]
    private static var stores: [String: WKWebsiteDataStore] = [:]
    static func capture(_ provider: String, completion: @escaping (Error?) -> Void) {
        store(provider).httpCookieStore.getAllCookies { cookies in
            do { try PlatformSessionCookieVault.save(cookies, provider: provider); completion(nil) }
            catch { completion(error) }
        }
    }
    private static func cookies(_ provider: String, completion: @escaping (Result<[HTTPCookie], Error>) -> Void) {
        let store = store(provider).httpCookieStore
        store.getAllCookies { current in
            do {
                if !current.isEmpty { completion(.success(current)); return }
                let saved = try PlatformSessionCookieVault.load(provider)
                let group = DispatchGroup()
                for cookie in saved {
                    group.enter(); store.setCookie(cookie) { group.leave() }
                }
                group.notify(queue: .main) { completion(.success(saved)) }
            } catch { completion(.failure(error)) }
        }
    }
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
            cookies(provider) { restored in
                guard case .success(let cookies) = restored else {
                    if case .failure(let error) = restored { completion(.failure(error)) }
                    return
                }
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
                let background = options["widgetBackground"] as? Bool == true
                if background {
                    diagnose(provider, fields: ["requestedAt": Date().timeIntervalSince1970 * 1000,
                        "cookieCount": cookies.count, "matchingCookieCount": applicable.count,
                        "phase": "request", "httpStatus": 0])
                }
                for (key, value) in HTTPCookie.requestHeaderFields(with: applicable) {
                    request.setValue(value, forHTTPHeaderField: key)
                }
                if method == "POST" {
                    request.httpBody = (options["body"] as? String)?.data(using: .utf8)
                    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
                }
                let receiver = PlatformPageReceiver(cookieStore: cookieStore, expected: expected) { result in
                    if background {
                        switch result {
                        case .success(let page): diagnose(provider, fields: ["phase": "response", "httpStatus": page["status"] as? Int ?? 0])
                        case .failure(let error): diagnose(provider, fields: ["phase": "transportError", "errorCode": (error as NSError).code])
                        }
                    }
                    switch result {
                    case .success(let response):
                        PlatformSessionTransport.capture(provider) { error in
                            if let error { completion(.failure(error)) }
                            else { completion(.success(response)) }
                        }
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
