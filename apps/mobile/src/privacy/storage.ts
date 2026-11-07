import { jsonFile } from '../shell/json-file'
import type { ConsentRecords } from './consent'
import { createConsentAccess } from './consent-access'

export const aiConsentRecords = jsonFile<ConsentRecords>('ai-data-consent.json')

export const aiConsent = createConsentAccess(aiConsentRecords)
