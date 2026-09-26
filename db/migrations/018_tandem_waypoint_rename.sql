-- Brand rename: the routing module is now called Waypoint (see README's
-- "Module names" table and HANDOFF.md's 2026-09-26 naming entry). This is
-- a rename, not a recreate, so any existing installation keeps its data --
-- ALTER TABLE/POLICY RENAME preserves rows, RLS, and grants untouched.
alter table tandem.routing_settings rename to waypoint_settings;

alter policy tandem_routing_settings_select on tandem.waypoint_settings
  rename to tandem_waypoint_settings_select;
alter policy tandem_routing_settings_admin_insert on tandem.waypoint_settings
  rename to tandem_waypoint_settings_admin_insert;
alter policy tandem_routing_settings_admin_update on tandem.waypoint_settings
  rename to tandem_waypoint_settings_admin_update;
alter policy tandem_routing_settings_admin_delete on tandem.waypoint_settings
  rename to tandem_waypoint_settings_admin_delete;
