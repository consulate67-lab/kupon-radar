import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import SeriesPage from './SeriesPage'
import './styles.css'

const path = window.location.pathname.replace(/\/+$/, '') || '/'
const Page = path === '/seri' ? SeriesPage : App

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
)
