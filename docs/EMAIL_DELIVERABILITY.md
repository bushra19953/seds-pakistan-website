# Email Deliverability Guide

This guide helps you configure reliable email delivery for authentication and transactional messages in production.

## DNS Authentication (SPF, DKIM, DMARC)

- SPF: Publish a TXT record to authorize your sending service.
  - Example (using Gmail/Google Workspace): `v=spf1 include:_spf.google.com ~all`
- DKIM: Enable DKIM signing in your email provider and add the provided `TXT` records.
- DMARC: Add a TXT record to monitor and enforce alignment.
  - Start with monitoring: `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com`
  - Move to enforcement (`p=quarantine` or `p=reject`) after confirming alignment.

## Custom Domain in Firebase Auth

- Set a custom domain for the auth handler (`auth.<yourdomain>.com`) in Firebase Authentication settings.
- Verify the domain and ensure DNS is correctly configured.
- Benefit: Email links (reset/verify) point to your domain, improving trust and deliverability.

## SMTP Provider Best Practices

- Prefer a dedicated transactional email provider (e.g., SendGrid, Mailgun, Postmark) for application emails.
- Warm up new domains/IPs by gradually increasing volume.
- Maintain a clean sending reputation:
  - Avoid sudden spikes in volume.
  - Honor unsubscribe preferences.
  - Send only to verified/opt-in recipients.

## Content and Sending Tips

- Use consistent `From:` name and address.
- Keep subject lines clear and non-spammy.
- Avoid excessive links and images; include a plain-text alternative.
- Localize content and ensure proper branding.

## Monitoring and Alerts

- Enable provider webhooks for bounces, complaints, and delivery events.
- Set up dashboards or alerts to watch bounce and complaint rates.
- Regularly review DMARC aggregate reports (`rua`).

## Troubleshooting Checklist

- DNS: SPF includes correct senders; DKIM is passing; DMARC reports show alignment.
- Application: Auth emails use your custom domain; links are valid and HTTPS.
- Provider: No rate limits or block lists; IP/domain reputation healthy.

## Next Steps

- Configure your DNS (SPF, DKIM, DMARC) for `yourdomain.com`.
- Set up a custom auth domain in Firebase.
- Choose an SMTP/transactional provider and integrate with your backend if needed.
