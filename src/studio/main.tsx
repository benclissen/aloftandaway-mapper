import '@fontsource/inter/400.css'
import '@fontsource/inter/600.css'
import { createRoot } from 'react-dom/client'
import { startRenderMode } from './render-mode.js'

const root = document.getElementById('root')
if (!root) throw new Error('The studio page has no #root element.')

if (new URLSearchParams(location.search).get('mode') === 'render') {
  startRenderMode(root)
} else {
  // The editing studio arrives in a later stage.
  createRoot(root).render(<p>Mapper studio</p>)
}
