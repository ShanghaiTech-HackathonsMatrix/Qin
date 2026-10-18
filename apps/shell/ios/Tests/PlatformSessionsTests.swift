import XCTest
import Capacitor
@testable import App

final class PlatformSessionsTests: XCTestCase {
    func testSchoolLoginUpgradePreservesServiceAndUsesSecureCookieSelection() throws {
        let raw = "http://ids.shanghaitech.edu.cn:80/authserver/login?service=https%3A%2F%2Felearning.shanghaitech.edu.cn%3A8443%2Fwebapps%2Flogin%3Fx%3D1%26y%3D2"
        var request = URLRequest(url: URL(string: raw)!)
        request.setValue("synthetic", forHTTPHeaderField: "Cookie")
        request.setValue("synthetic", forHTTPHeaderField: "Authorization")
        let result = try XCTUnwrap(PlatformLoginNavigation.secureSchoolLoginRequest(request))
        XCTAssertEqual(result.url?.scheme, "https")
        XCTAssertEqual(result.url?.host, "ids.shanghaitech.edu.cn")
        XCTAssertNil(result.url?.port)
        XCTAssertEqual(result.url?.path, request.url?.path)
        XCTAssertEqual(result.url?.query, request.url?.query)
        XCTAssertEqual(result.httpMethod, "GET")
        XCTAssertNil(result.value(forHTTPHeaderField: "Cookie"))
        XCTAssertNil(result.value(forHTTPHeaderField: "Authorization"))
    }
    func testSchoolLoginUpgradeDoesNotReplayPostsOrUpgradeOtherOrigins() {
        for raw in ["http://ids.shanghaitech.edu.cn.evil.test/", "http://evil.test/",
                    "http://ids.shanghaitech.edu.cn:8080/", "http://user:pass@ids.shanghaitech.edu.cn/",
                    "https://ids.shanghaitech.edu.cn/", "http://elearning.shanghaitech.edu.cn:8443/"] {
            XCTAssertNil(PlatformLoginNavigation.secureSchoolLoginRequest(URLRequest(url: URL(string: raw)!)))
        }
        var request = URLRequest(url: URL(string: "http://ids.shanghaitech.edu.cn/authserver/login")!)
        request.httpMethod = "POST"; request.httpBody = Data("synthetic=test".utf8)
        XCTAssertNil(PlatformLoginNavigation.secureSchoolLoginRequest(request))
        request.httpMethod = "GET"
        XCTAssertNil(PlatformLoginNavigation.secureSchoolLoginRequest(request))
    }
    func testOnlyNavigationInterruptionsAreTransient() {
        XCTAssertTrue(PlatformLoginNavigation.isInterrupted(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)))
        XCTAssertTrue(PlatformLoginNavigation.isInterrupted(NSError(domain: "WebKitErrorDomain", code: 102)))
        for error in [NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut),
                      NSError(domain: NSURLErrorDomain, code: NSURLErrorServerCertificateUntrusted),
                      NSError(domain: "WKErrorDomain", code: 102)] {
            XCTAssertFalse(PlatformLoginNavigation.isInterrupted(error))
        }
    }
    func testLoginNavigationPreservesHTTPSAndBlankPopupOnly() {
        for raw in ["https://elearning.shanghaitech.edu.cn:8443/", "https://sso.shanghaitech.edu.cn/", "about:blank"] {
            XCTAssertTrue(PlatformLoginNavigation.allows(URL(string: raw)))
        }
        for raw in ["http://elearning.shanghaitech.edu.cn/", "file:///tmp/test", "javascript:alert(1)"] {
            XCTAssertFalse(PlatformLoginNavigation.allows(URL(string: raw)))
        }
        XCTAssertFalse(PlatformLoginNavigation.allows(nil))
    }
    private let entry = URL(string: "https://elearning.shanghaitech.edu.cn:8443/webapps/portal")!
    func testOriginRequiresMatchingHTTPSPortAndNoCredentials() {
        XCTAssertTrue(PlatformRequestPolicy.sameOrigin(URL(string: "https://elearning.shanghaitech.edu.cn:8443/webapps/assignment")!, entry))
        for raw in ["https://elearning.shanghaitech.edu.cn/webapps", "http://elearning.shanghaitech.edu.cn:8443/",
                    "https://user:pass@elearning.shanghaitech.edu.cn:8443/", "https://elearning.shanghaitech.edu.cn.evil.test:8443/"] {
            XCTAssertFalse(PlatformRequestPolicy.sameOrigin(URL(string: raw)!, entry))
        }
    }

    func testOnlyKnownEAMSPostPathsAreAllowed() {
        for path in ["/eams/courseTableForStd.action", "/eams/courseTableForStd!courseTable.action"] {
            let url = URL(string: "https://eams.shanghaitech.edu.cn" + path)!
            XCTAssertTrue(PlatformRequestPolicy.allows(method: "POST", provider: "eams", url: url))
            XCTAssertFalse(PlatformRequestPolicy.allows(method: "POST", provider: "blackboard", url: url))
        }
        let url = URL(string: "https://eams.shanghaitech.edu.cn/eams/courseTableForStd!delete.action")!
        XCTAssertFalse(PlatformRequestPolicy.allows(method: "POST", provider: "eams", url: url))
        XCTAssertFalse(PlatformRequestPolicy.allows(method: "DELETE", provider: "eams", url: url))
    }

    func testCookiePathAndDomainBoundariesAndExpiry() throws {
        let cookie = try XCTUnwrap(HTTPCookie(properties: [.name: "test", .value: "synthetic",
            .domain: ".shanghaitech.edu.cn", .path: "/webapps", .secure: "TRUE",
            .expires: Date(timeIntervalSinceNow: 3600)]))
        XCTAssertTrue(PlatformRequestPolicy.applicable(cookie, url: entry))
        for raw in ["https://elearning.shanghaitech.edu.cn:8443/webapps-other", "https://shanghaitech.edu.cn.evil.test/webapps",
                    "http://elearning.shanghaitech.edu.cn/webapps"] {
            XCTAssertFalse(PlatformRequestPolicy.applicable(cookie, url: URL(string: raw)!))
        }
        XCTAssertFalse(PlatformRequestPolicy.applicable(cookie, url: entry, now: Date(timeIntervalSinceNow: 7200)))
    }

    func testBridgeRejectsUntrustedRequestsBeforeAccessingCookies() {
        let plugin = PlatformSessionsPlugin()
        let options: [[String: Any]] = [
            ["provider": "unknown", "url": entry.absoluteString],
            ["provider": "blackboard", "url": "https://example.com"],
            ["provider": "blackboard", "url": entry.absoluteString, "method": "POST"]
        ]
        for option in options {
            let rejected = expectation(description: "Rejected before networking")
            let call = CAPPluginCall(callbackId: "test", methodName: "request", options: option, success: { _, _ in
                XCTFail("Unexpected success")
            }, error: { _ in rejected.fulfill() })!
            plugin.request(call)
            wait(for: [rejected], timeout: 1)
        }
    }
}
