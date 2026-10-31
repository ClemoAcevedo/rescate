import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { ChatPage } from '../pages/ChatPage'
import { AppLayout } from '../components/AppLayout'
import { ConnectionPage } from '../pages/ConnectionPage'
import { LoginPage } from '../pages/LoginPage'
import { LotDetailPage } from '../pages/LotDetailPage'
import { LotEditorPage } from '../pages/LotEditorPage'
import { LotsPage } from '../pages/LotsPage'
import { MyLotsPage } from '../pages/MyLotsPage'
import { NotFoundPage } from '../pages/NotFoundPage'
import { NotificationsPage } from '../pages/NotificationsPage'
import { PanelPage } from '../pages/PanelPage'
import { PickupsPage } from '../pages/PickupsPage'
import { ReservationsPage, ReservationDetailPage } from '../pages/ReservationsPage'
import { JoinWaitlistPage, WaitlistPage, WaitlistDetailPage } from '../pages/WaitlistPage'
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
        <Route path="operador/panel" element={<PanelPage />} />
        <Route path="operador/lotes" element={<MyLotsPage />} />
        <Route path="operador/lotes/nuevo" element={<LotEditorPage />} />
        <Route path="operador/lotes/:lotId" element={<LotEditorPage />} />
        <Route path="operador/lotes/:lotId/retiros" element={<PickupsPage />} />
        <Route path="lotes/:id/espera" element={<JoinWaitlistPage />} />
        <Route path="espera" element={<WaitlistPage />} />
        <Route path="espera/:id" element={<WaitlistDetailPage />} />
        <Route path="avisos" element={<NotificationsPage />} />
        <Route path="reservas" element={<ReservationsPage />} />
        <Route path="reservas/:id/chat" element={<ChatPage />} />
        <Route path="reservas/:id" element={<ReservationDetailPage />} />
        <Route path="registro" element={<RegisterPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="conexion" element={<ConnectionPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}

export default App
