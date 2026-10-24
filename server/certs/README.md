Supabase public CA certificate, downloaded over verified HTTPS from:
https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

The Supabase Studio source publishes this URL in:
https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json

This is a public certificate, not a private key. The backend uses it to verify
the Supabase Postgres pooler certificate and hostname. TLS verification stays on.
