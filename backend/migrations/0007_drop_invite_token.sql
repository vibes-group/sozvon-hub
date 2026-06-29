-- Drop the plaintext invite-token column. Invites are looked up and consumed
-- solely by token_hash; the cleartext copy was write-only and never read, so it
-- stored a one-time registration secret in the clear for no functional reason.
alter table account_invites drop column token;
