-- Processing rate was set to 0.10 in the schema default, which silently added
-- a $0.10/lb processing labor charge to every estimate. Zero it out so rates
-- are only non-zero when explicitly entered.
UPDATE estimates SET processing_rate = 0 WHERE processing_rate = 0.10;
