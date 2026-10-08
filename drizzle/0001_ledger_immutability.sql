-- Module 10 invariants, enforced in the database so no code path can bypass them.

ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_amount_pos CHECK (amount > 0);
--> statement-breakpoint

-- 1. Append-only: no UPDATE/DELETE on ledger or audit tables. Corrections = reversing transaction.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP;
END $$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_immutable BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint

-- 2. Every transaction must balance (debits = credits), checked at COMMIT so lines can be inserted one by one.
CREATE FUNCTION check_ledger_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE net numeric;
BEGIN
  SELECT COALESCE(SUM(CASE direction WHEN 'debit' THEN amount ELSE -amount END), 0)
    INTO net FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF net <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced by % paise', NEW.transaction_id, net;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ledger_balanced();
