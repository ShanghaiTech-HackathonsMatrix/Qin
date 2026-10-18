import Capacitor

class MatrixBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(MatrixWidgetPlugin())
        bridge?.registerPluginInstance(PlatformSessionsPlugin())
    }
}
