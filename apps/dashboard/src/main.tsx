import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App.tsx';
import { Join } from './Join.tsx';

// /join is the only page a teammate may open: static instructions, no dashboard data, no API calls.
createRoot(document.getElementById('root')!).render(window.location.pathname === '/join' ? <Join /> : <App />);
