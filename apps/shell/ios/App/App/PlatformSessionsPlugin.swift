import Capacitor
import WebKit

enum PlatformRequestPolicy {
    static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        a.scheme == "https" && a.host == b.host && (a.port ?? 443) == (b.port ?? 443)
            && a.user == nil && a.password == nil
    }
    static func allows(method: String, provider: String, url: URL) -> Bool {
        method == "GET" || (method == "POST" && provider == "eams"
            && ["/eams/courseTableForStd.action", "/eams/courseTableForStd!courseTable.action"].contains(url.path))
    }
    static func applicable(_ cookie: HTTPCookie, url: URL, now: Date = Date()) -> Bool {
        let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
        let host = url.host ?? ""
        let domainMatches = host == domain || (cookie.domain.hasPrefix(".") && host.hasSuffix("." + domain))
        let path = url.path.isEmpty ? "/" : url.path
        let pathMatches = path == cookie.path || (path.hasPrefix(cookie.path)
            && (cookie.path.hasSuffix("/") || path.dropFirst(cookie.path.count).hasPrefix("/")))
        return domainMatches && pathMatches && (!cookie.isSecure || url.scheme == "https")
            && (cookie.expiresDate == nil || cookie.expiresDate! > now)
    }
}

/** Cookies stay in provider-specific WebKit stores; the JS bridge only receives page content. */
@objc(PlatformSessionsPlugin)
public class PlatformSessionsPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionTaskDelegate {
    public let identifier = "PlatformSessionsPlugin"
    public let jsName = "PlatformSessions"
    public let pluginMethods: [CAPPluginMethod] = ["login", "clear", "request", "openExternal"].compactMap {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private var activeLogin: PlatformLoginController?
    @objc func login(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let provider = call.getString("provider"), let raw = PlatformSessionTransport.entries[provider],
                  let url = URL(string: raw), let presenter = self.bridge?.viewController else {
                call.reject("未知平台或登录窗口不可用"); return
            }
            guard self.activeLogin == nil, presenter.presentedViewController == nil else {
                call.reject("已有窗口打开，请先完成或取消"); return
            }
            let controller = PlatformLoginController(url: url, provider: provider, store: PlatformSessionTransport.store(provider)) { completed in
                self.activeLogin = nil
                call.resolve(["completed": completed])
            }
            self.activeLogin = controller
            let navigation = UINavigationController(rootViewController: controller)
            navigation.isModalInPresentation = true
            presenter.present(navigation, animated: true)
        }
    }
    @objc func clear(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.activeLogin == nil else { call.reject("请先关闭平台登录窗口"); return }
            do {
                for provider in PlatformSessionTransport.entries.keys { try PlatformSessionCookieVault.clear(provider) }
            } catch { call.reject(error.localizedDescription); return }
            let group = DispatchGroup()
            for provider in PlatformSessionTransport.entries.keys {
                group.enter()
                PlatformSessionTransport.store(provider).removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
                                               modifiedSince: .distantPast) { group.leave() }
            }
            group.notify(queue: .main) { call.resolve() }
        }
    }
    @objc func openExternal(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw),
              ["https", "http"].contains(url.scheme ?? ""), url.host != nil,
              url.user == nil, url.password == nil else { call.reject("无效外链"); return }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() } else { call.reject("无法打开外部浏览器") }
            }
        }
    }
    @objc func request(_ call: CAPPluginCall) {
        let options = call.options.reduce(into: [String: Any]()) { result, pair in
            if let key = pair.key as? String { result[key] = pair.value }
        }
        _ = PlatformSessionTransport.request(options: options) { result in
            switch result {
            case .success(let response): call.resolve(response)
            case .failure(let error): call.reject(error.localizedDescription)
            }
        }
    }
}


enum PlatformLoginNavigation {
    static func isInterrupted(_ error: NSError) -> Bool {
        (error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled)
            || (error.domain == "WebKitErrorDomain" && error.code == 102)
    }
    static func allows(_ url: URL?) -> Bool {
        url?.scheme?.lowercased() == "https" || url?.absoluteString == "about:blank"
    }
    static func secureSchoolLoginRequest(_ request: URLRequest) -> URLRequest? {
        guard let url = request.url, url.scheme?.lowercased() == "http",
              url.host?.lowercased() == "ids.shanghaitech.edu.cn",
              url.port == nil || url.port == 80,
              url.user == nil, url.password == nil,
              ["GET", "HEAD"].contains(request.httpMethod ?? "GET"),
              request.httpBody == nil, request.httpBodyStream == nil,
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        // The school's HTTP endpoint itself redirects to HTTPS. Upgrade before any
        // request is sent, preserving the CAS service query without rewriting it.
        components.scheme = "https"; components.port = nil
        guard let secureURL = components.url else { return nil }
        var secureRequest = request; secureRequest.url = secureURL
        secureRequest.setValue(nil, forHTTPHeaderField: "Cookie")
        secureRequest.setValue(nil, forHTTPHeaderField: "Authorization")
        return secureRequest
    }
}

final class PlatformLoginController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let webView: WKWebView
    private let initialURL: URL
    private let provider: String
    private let completion: (Bool) -> Void
    private let status = UILabel()
    private var stack: UIStackView!
    private var popups: [WKWebView] = []
    private var blockedMessage: String?
    private var navigationTimeout: DispatchWorkItem?
    private var currentWebView: WKWebView { popups.last ?? webView }
    init(url: URL, provider: String, store: WKWebsiteDataStore, completion: @escaping (Bool) -> Void) {
        let config = WKWebViewConfiguration(); config.websiteDataStore = store
        self.webView = WKWebView(frame: .zero, configuration: config)
        self.initialURL = url; self.provider = provider; self.completion = completion
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "平台登录 / Sign in"
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "取消", style: .plain, target: self, action: #selector(cancel))
        navigationItem.rightBarButtonItems = [
            UIBarButtonItem(title: "完成并检测", style: .done, target: self, action: #selector(done)),
            UIBarButtonItem(title: "重试", style: .plain, target: self, action: #selector(retry))
        ]
        status.text = "登录后点击完成，App 将检测实际会话。"; status.font = .preferredFont(forTextStyle: .caption1)
        status.numberOfLines = 0; status.backgroundColor = .secondarySystemBackground
        stack = UIStackView(arrangedSubviews: [status, webView]); stack.axis = .vertical
        stack.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(stack)
        NSLayoutConstraint.activate([stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor), stack.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor)])
        webView.navigationDelegate = self; webView.uiDelegate = self
        webView.load(URLRequest(url: initialURL))
    }
    @objc private func cancel() { dismiss(animated: true) { self.completion(false) } }
    @objc private func done() {
        status.text = "正在安全保存本机会话…"
        PlatformSessionTransport.capture(provider) { error in
            if let error { self.status.text = error.localizedDescription; return }
            self.dismiss(animated: true) { self.completion(true) }
        }
    }
    @objc private func retry() {
        blockedMessage = nil
        if currentWebView.url == nil { currentWebView.load(URLRequest(url: initialURL)) }
        else { currentWebView.reload() }
    }
    private func waitForPage() {
        navigationTimeout?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.status.text = self.blockedMessage ?? "登录页面尚未完成加载，请等待或点击重试；尚未确认登录成功。"
        }
        navigationTimeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 25, execute: work)
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard webView === currentWebView else { return }
        blockedMessage = nil
        status.text = "正在加载登录页面…"
        waitForPage()
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === currentWebView else { return }
        navigationTimeout?.cancel()
        status.text = blockedMessage ?? "页面已加载；登录后点击完成，App 将检测实际会话。"
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let secureRequest = PlatformLoginNavigation.secureSchoolLoginRequest(navigationAction.request) {
            decisionHandler(.cancel)
            blockedMessage = nil
            status.text = "正在通过 HTTPS 打开学校统一认证…"
            // Authentication is interactive: a legacy HTTP frame also becomes a
            // top-level HTTPS login page, rather than allowing insecure subframes.
            webView.load(secureRequest)
            return
        }
        let allowed = PlatformLoginNavigation.allows(navigationAction.request.url)
        if !allowed {
            // Do not include query strings, credentials or SSO tickets in diagnostics.
            let url = navigationAction.request.url
            blockedMessage = "登录跳转已阻止：\(url?.scheme ?? "未知协议") / \(url?.host ?? "无主机")；请重试或反馈此提示。"
            status.text = blockedMessage
        }
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard navigationAction.targetFrame == nil,
              PlatformLoginNavigation.allows(navigationAction.request.url), popups.count < 3 else { return nil }
        // Preserve the supplied configuration and opener relationship for SSO popups.
        // This WebView has no Capacitor bridge and uses the same provider's cookie store.
        let popup = WKWebView(frame: .zero, configuration: configuration)
        popup.navigationDelegate = self; popup.uiDelegate = self
        currentWebView.isHidden = true
        popups.append(popup); stack.addArrangedSubview(popup)
        return popup
    }
    func webViewDidClose(_ webView: WKWebView) {
        guard webView === popups.last else { return }
        popups.removeLast(); stack.removeArrangedSubview(webView); webView.removeFromSuperview()
        currentWebView.isHidden = false
        status.text = "登录窗口已关闭；点击完成以检测实际会话。"
    }
    private func showFailure(_ error: Error, in webView: WKWebView) {
        guard webView === currentWebView else { return }
        let error = error as NSError
        if PlatformLoginNavigation.isInterrupted(error) {
            status.text = blockedMessage ?? "登录页面正在切换，请稍候…"
            waitForPage()
            return
        }
        navigationTimeout?.cancel()
        status.text = "页面加载失败：\(error.localizedDescription)（\(error.domain) / \(error.code)）。可点击重试。"
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showFailure(error, in: webView)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showFailure(error, in: webView)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === currentWebView else { return }
        navigationTimeout?.cancel()
        status.text = "登录页面进程已停止，请点击重试。"
    }
}
