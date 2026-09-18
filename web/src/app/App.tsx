import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppLayout } from '../components/AppLayout'
import { ConnectionPage } from '../pages/ConnectionPage'
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
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<RootRedirect />} />
        <Route path="lotes" element={<LotsPage />} />
        <Route path="lotes/:id" element={<LotDetailPage />} />
        <Route path="registro" element={<RegisterPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="conexion" element={<ConnectionPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}

export default App
