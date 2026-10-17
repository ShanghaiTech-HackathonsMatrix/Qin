import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('找不到 #root 挂载点');

// 刻意不用 StrictMode：开发模式下它会重复执行 effect，
// 导致启动自检跑两遍、探针重复建临时库，调试时反而看不清。
createRoot(el).render(<App />);
