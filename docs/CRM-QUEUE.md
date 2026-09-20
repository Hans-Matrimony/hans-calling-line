# Manual CRM queue export

CRM requested-lead pages now have a collapsible **Send requested leads to Hans Dialer** panel. Load the pending leads, select them, enter an existing active dialer rep email and press Send selected to Dialer. A missing or disabled rep is rejected; no account is created. Rep users continue to connect audio and dial in the existing Hans dashboard.

## Activation

Deploy both repositories. On the dialer set CRM_QUEUE_TOKEN to a random secret of at least 32 characters. Set the identical value as HANS_DIALER_QUEUE_TOKEN on the CRM server. Keep both values server-side. On CRM set HANS_DIALER_URL=https://hans-calling-line.api.hansastro.com (HTTPS, no trailing API path).

Run the dialer migration (npm run migrate --prefix server; Docker startup already runs migrations) and restart it. Rebuild the CRM config/route/view caches using the normal deployment process, including php artisan config:cache and php artisan view:clear. Environment examples contain placeholders, not usable credentials.

## Behavior

- Only today's requested rows belonging to the signed-in CRM user are selectable, matching the existing requested-lead flow. Existing CRM roles 3, 5 and 7 can use it.
- Website/exhaust numbers come from leads + user_data. Other supported requested types use incomplete_leads. Browser-supplied phone or name fields are ignored.
- The API POST /api/integrations/crm/queue requires Authorization: Bearer <CRM_QUEUE_TOKEN>. Body: {repEmail, leads: [{externalId, name, phone}]} (1-100 leads).
- Phone validation is atomic: invalid input rejects the batch before any writes. Ten-digit local phones are interpreted as India; international numbers must include their country code.
- Repeated sends to the same rep do not duplicate the external identity or same phone, reset attempts, reopen completed leads or overwrite an active conversation. Existing means already present, not necessarily still queued. A different rep has a separate queue.
- CRM requested status, lead ownership, Pickup/Not Pickup and existing request controls are not modified. No call outcomes are written back. Sending does not dial.
- A timeout may happen after the dialer has committed; retry the same selection and rep safely.
- New queue entries emit queue:changed to the selected rep. Calling windows and caller-ID availability still apply.

## Validation

node server/scripts/test-local.mjs crm-test.mjs

On the CRM repository: php vendor/phpunit/phpunit/phpunit tests/Feature/DialerQueueTest.php
Tests use isolated databases and fake HTTP. Do not use live customer calls to test queue export.
