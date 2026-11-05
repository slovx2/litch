import { jsonFile } from '../shell/json-file'
import type { ConsentRecords } from './consent'

export const aiConsentRecords = jsonFile<ConsentRecords>('ai-data-consent.json')
