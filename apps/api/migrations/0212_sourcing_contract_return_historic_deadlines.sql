-- Previously backfilled orders already retain the first ready PDF timestamp
-- and its 48-hour Sunday-free due date. Remove the catch-up exemption so
-- existing orders have the same overdue status as newly approved orders.
UPDATE sourcing_contract_return_monitors
SET contract_return_catchup=false
WHERE contract_return_catchup=true;
