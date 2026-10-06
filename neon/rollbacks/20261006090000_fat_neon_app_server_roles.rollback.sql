-- Rollback of 20261006090000_fat_neon_app_server_roles.sql (WORK-256).
-- Removes the two FAT application login roles. Every FAT/Neon-routed app session
-- stops working (the routing rollback FAT_BACKEND=supabase should come first).
-- Neither role owns objects (they only SET ROLE into fat_app / fat_service), so
-- DROP ROLE succeeds; if it does not, something unexpected was created by them.
revoke fat_app from fat_app_server;
revoke fat_service from fat_identity_provisioner;
drop role if exists fat_app_server;
drop role if exists fat_identity_provisioner;
delete from fat_migrations.schema_migrations where version = '20261006090000';
