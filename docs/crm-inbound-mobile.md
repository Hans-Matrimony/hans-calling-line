# Auto Calling inbound mobile routing

A customer calling back a configured Plivo number is forwarded to the active TSE who most recently dialed that customer through Auto Calling from that number. The destination is the admin-configured mobile in hans_calling_inbound_settings, normalized with +91 for ten-digit Indian numbers. Admins set or clear it on CRM /crm/auto-calling under Inbound forwarding numbers; CRM login mobile is unchanged. The TSE answers on their mobile without a browser login. Outbound browser audio and outcomes are unchanged.

Manual Request Leads calls do not select the inbound owner. Failed provider submissions do not select an owner. If there is no matching Auto Calling attempt, the latest TSE is inactive, or no valid custom number is set, calls forward to 9697989697. A custom destination that loops back to the caller/Plivo number also uses this fallback. If the fallback itself would loop, the caller hears an unavailable message. Busy/no-answer on a custom number does not trigger a second dial. Mobile ringing times out after 30 seconds; a connected call is limited to four hours. The TSE sees the Plivo number as caller ID.

## Activation

1. Deploy the CRM admin settings code and run migration 2026_09_28_000001_create_hans_calling_inbound_settings.php. Run the existing CRM schema migration (CALLING_STORAGE=crm_mysql npm run migrate from server with the configured environment). This adds hans_calling_inbound_calls without changing outbound tables.
2. Deploy/restart the calling service during a window without active calls.
3. Set CRM_INBOUND_MOBILE_ENABLED=true in the calling service environment, not Laravel's .env.
4. For the Plivo application attached to the inbound-enabled number, configure POST Answer URL as https://hans-calling-line.api.hansastro.com/webhooks/crm/inbound and POST Hangup URL as https://hans-calling-line.api.hansastro.com/webhooks/crm/inbound/hangup. Keep the existing outbound/browser application settings; if the number shares the browser application, use a separate application for inbound numbers.
5. Confirm a customer callback reaches the latest TSE's handset. Provider number/application activation and a real handset call are required for end-to-end verification.

All callbacks require Plivo V3 signatures. Inbound lifecycle and selected destination are stored separately in hans_calling_inbound_calls, keyed by incoming CallUUID; retries reuse the selected TSE. Outbound counters and CRM lead statuses are unaffected. Set CRM_INBOUND_MOBILE_ENABLED=false to stop new mobile forwards.

Plivo reference: https://www.plivo.com/docs/voice/xml/routing
