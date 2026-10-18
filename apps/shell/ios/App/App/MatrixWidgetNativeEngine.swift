import Foundation
import JavaScriptCore

/// No WebView or foreground React runtime: evaluate bundled connectors on a serial JSC queue.
final class MatrixWidgetNativeEngine {
    typealias Transport = ([String: Any], @escaping (Result<[String: Any], Error>) -> Void) -> PlatformNetworkOperation
    private let transport: Transport
    init(transport: @escaping Transport = { PlatformSessionTransport.request(options: $0, completion: $1) }) {
        self.transport = transport
    }
    private let queue = DispatchQueue(label: "dev.matrix.widget.javascript")
    private var context: JSContext?
    private var finish: ((Result<String, Error>) -> Void)?
    private var operations: [String: PlatformNetworkOperation] = [:]
    private var closed = false

    static func error(_ message: String) -> NSError {
        NSError(domain: "MatrixWidgetSync", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    static func json(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value), let raw = String(data: data, encoding: .utf8) else { return "{}" }
        return raw
    }
    static func resolveURL(_ raw: String, base: String) -> String {
        guard let url = URL(string: raw, relativeTo: base.isEmpty ? nil : URL(string: base))?.absoluteURL,
              let c = URLComponents(url: url, resolvingAgainstBaseURL: true),
              let scheme = c.scheme?.lowercased(), let host = c.host?.lowercased(),
              ["https", "http"].contains(scheme) else { return "{\"error\":true}" }
        let defaultPort = scheme == "https" ? 443 : 80
        let port = c.port == nil || c.port == defaultPort ? "" : ":\(c.port!)"
        let origin = "\(scheme)://\(host)\(port)"
        let credentials = c.user == nil ? "" : "\(c.percentEncodedUser ?? "")\(c.password == nil ? "" : ":" + (c.percentEncodedPassword ?? ""))@"
        return json(["protocol": scheme + ":", "hostname": host, "origin": origin,
                     "authority": "\(scheme)://\(credentials)\(host)\(port)",
                     "username": c.percentEncodedUser ?? "", "password": c.percentEncodedPassword ?? "",
                     "pathname": c.percentEncodedPath.isEmpty ? "/" : c.percentEncodedPath,
                     "search": c.percentEncodedQuery.map { "?" + $0 } ?? "",
                     "hash": c.percentEncodedFragment.map { "#" + $0 } ?? ""])
    }

    func run(input: String, timeout: TimeInterval = 25) async throws -> String {
        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                queue.async {
                    guard !self.closed else { continuation.resume(throwing: Self.error("同步已取消")); return }
                    self.finish = { continuation.resume(with: $0) }
                    self.start(input: input)
                    self.queue.asyncAfter(deadline: .now() + timeout) {
                        self.complete(.failure(Self.error("平台检查超时，保留上次信息；请稍后重试")))
                    }
                }
            }
        }, onCancel: { self.cancel() })
    }
    func cancel() { queue.async { self.complete(.failure(Self.error("同步已取消，保留上次信息"))) } }
    private func complete(_ result: Result<String, Error>) {
        guard !closed else { return }
        closed = true
        operations.values.forEach { $0.cancel() }; operations.removeAll()
        let callback = finish; finish = nil
        context?.exceptionHandler = nil; context = nil
        callback?(result)
    }
    private func start(input: String) {
        guard let scriptURL = Bundle.main.url(forResource: "ios-widget-runtime", withExtension: "js", subdirectory: "public"),
              let script = try? String(contentsOf: scriptURL, encoding: .utf8),
              let urlShim = Bundle.main.url(forResource: "MatrixWidgetURL", withExtension: "js"),
              let shim = try? String(contentsOf: urlShim, encoding: .utf8), let js = JSContext() else {
            complete(.failure(Self.error("本地同步引擎资源缺失，请重新安装应用"))); return
        }
        context = js
        js.exceptionHandler = { [weak self] _, exception in
            self?.complete(.failure(Self.error("本地同步引擎错误：\(exception?.toString() ?? "未知错误")")))
        }
        let resolve: @convention(block) (String, String) -> String = { Self.resolveURL($0, base: $1) }
        let finished: @convention(block) (String) -> Void = { [weak self] raw in self?.complete(.success(raw)) }
        let request: @convention(block) (String, String, String) -> Void = { [weak self] provider, raw, id in
            guard let self, !self.closed, let data = raw.data(using: .utf8),
                  var options = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
            options["provider"] = provider
            options["timeout"] = 12000.0
            options["widgetBackground"] = true
            let operation = self.transport(options) { [weak self] result in
                guard let self else { return }
                self.queue.async {
                    guard !self.closed else { return }
                    self.operations.removeValue(forKey: id)
                    let response: String
                    switch result {
                    case .success(let page): response = Self.json(page)
                    case .failure(let error): response = Self.json(["error": error.localizedDescription])
                    }
                    self.context?.objectForKeyedSubscript("MatrixWidgetRuntime")?.objectForKeyedSubscript("receive")?
                        .call(withArguments: [id, response])
                }
            }
            self.operations[id] = operation
        }
        js.setObject(resolve, forKeyedSubscript: "_matrixURL" as NSString)
        js.setObject(request, forKeyedSubscript: "_matrixRequest" as NSString)
        js.setObject(finished, forKeyedSubscript: "_matrixFinish" as NSString)
        js.evaluateScript(shim)
        js.evaluateScript("var MatrixNative = {request: _matrixRequest, finish: _matrixFinish};")
        js.evaluateScript(script)
        guard !closed else { return }
        js.objectForKeyedSubscript("MatrixWidgetRuntime")?.objectForKeyedSubscript("start")?.call(withArguments: [input])
    }
}
