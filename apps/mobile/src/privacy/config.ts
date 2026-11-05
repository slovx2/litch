export const CONTENT_FEEDBACK_EMAIL: string = 'admin@datawake.cc'
export const PRIVACY_URL = 'https://github.com/slovx2/litch/blob/main/docs/ios-privacy.md'
export const ISSUES_URL = 'https://github.com/slovx2/litch/issues/new'
export const LICENSES_URL = 'https://github.com/slovx2/litch/blob/main/THIRD_PARTY_NOTICES.md'

export function feedbackURL(subject: string): string {
  return CONTENT_FEEDBACK_EMAIL
    ? `mailto:${CONTENT_FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}`
    : ISSUES_URL
}
