// Fonts are bundled from npm (no CDN at runtime): Martian Mono (variable 100–800) and Barlow Condensed 200.
import '@fontsource-variable/martian-mono';
import '@fontsource/barlow-condensed/200.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(<App />);
