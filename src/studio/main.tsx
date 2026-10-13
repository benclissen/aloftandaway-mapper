import '@fontsource/inter/400.css'
import '@fontsource/inter/600.css'
import { createRoot } from 'react-dom/client'
import { startRenderMode } from './render-mode.js'

const root = document.getElementById('root')
if (!root) throw new Error('The studio page has no #root element.')

if (new URLSearchParams(location.search).get('mode') === 'render') {
  startRenderMode(root)
} else {
  // Loaded on demand, so render mode never gets the edit app or its styles.
  void import('./edit/App.js').then(({ App }) => createRoot(root).render(<App />))
}
