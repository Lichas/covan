import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import 'katex/dist/katex.min.css'
import './index.css'
import './glass.css'
import './ui.css'
import { api } from './lib/api'
import { BrowserWorkspace } from './components/BrowserWorkspace'

document.documentElement.dataset.nativeGlass = String(api.nativeGlass === true)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {new URLSearchParams(location.search).get('browserBot') ? <BrowserWorkspace botId={new URLSearchParams(location.search).get('browserBot')!} /> : <App />}
  </React.StrictMode>,
)
