import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppLayout } from '../layouts/AppLayout'
import { LoginPage } from '../pages/LoginPage'
import { LotDetailPage } from '../pages/LotDetailPage'
import { LotsPage } from '../pages/LotsPage'
import { NotFoundPage } from '../pages/NotFoundPage'
import { RegisterPage } from '../pages/RegisterPage'

function RootRedirect() {
  const { search } = useLocation()

  return <Navigate replace to={{ pathname: '/lotes', search }} />
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route element={<AppLayout />}>
          <Route path="/lotes" element={<LotsPage />} />
          <Route path="/lotes/:id" element={<LotDetailPage />} />
          <Route path="/registro" element={<RegisterPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
