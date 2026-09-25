-- `vehicle_count` was a leftover from the fleet/logistics use case this
-- package was originally extracted from. The lead-qualification threshold
-- is a generic numeric field, not fleet-specific, so rename it to match.
alter table tandem.leads rename column vehicle_count to qualification_metric;
