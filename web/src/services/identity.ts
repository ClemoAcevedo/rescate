import { createIdentityService, type IdentityService } from './identity-service'
import { createMockIdentityService } from './mock-identity-service'

export const identityService: IdentityService = createMockIdentityService() ?? createIdentityService()
export const isMockIdentityService = Boolean(createMockIdentityService())
