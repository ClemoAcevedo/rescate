import { Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from '../components/AppLayout'
import { LoginPage } from '../pages/LoginPage'
import { LotDetailPage } from '../pages/LotDetailPage'
import { LotsPage } from '../pages/LotsPage'
import { NotFoundPage } from '../pages/NotFoundPage'
import { RegisterPage } from '../pages/RegisterPage'

function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Navigate to="/lotes" replace />} />
        <Route path="lotes" element={<LotsPage />} />
        <Route path="lotes/:id" element={<LotDetailPage />} />
        <Route path="registro" element={<RegisterPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}

export default App
