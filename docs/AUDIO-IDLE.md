# Browser audio idle billing

Pressing **Call**, **Call again**, **Start calling** or **Next lead** connects audio first when needed. The customer is dialed only after both the browser audio call and the backend conference are ready. Audio setup failure or timeout stops the dial; repeated clicks cannot create duplicate calls. The optional **Connect** button uses the same readiness check. Opening or refreshing the dashboard does not start a new paid SIP call.

The server checks every 10 seconds and disconnects browser audio after 120 seconds without a customer call (normally within 120-130 seconds). Ringing, live and waiting incoming calls prevent expiry. A new outbound dial reservation resets the grace period. After a customer call ends, its end time starts a fresh grace period. Outcome forms and saved/draft notes are not discarded by audio expiry; a rep can reconnect and continue after saving the outcome.

Queue browsing and typing notes do not keep audio billable. A run paused between leads for two minutes will reconnect audio automatically on the next call. Incoming callbacks follow the existing queue fallback while audio is off. Phone-mode audio is unchanged.

The cutoff runs without the browser and uses database state across restarts. Failed provider hangups retry on the next sweep; retries target the original call, never a replacement session.

Deploy the server and client together. The normal startup migration adds nullable `users.audio_activity_at` and `plivo_calls.idle_disconnect_at` columns. Existing idle browser sessions also become eligible for the cutoff on deployment. No production migration or live call is required for the isolated regression tests.
