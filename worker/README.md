# Private Control Worker

This service must run on a trusted VPS or local control machine, not inside the Netlify browser bundle.

Responsibilities:
- encrypted server credentials / SSH keys
- SSH connections
- command allowlist
- WP-CLI operations
- OS/package/file telemetry
- security auditing
- job queue
- audit logs
- Claude tool execution

Recommended actions:
- inventory_server
- inventory_domains
- read_telemetry
- read_inodes
- read_disk
- list_packages
- list_services
- list_ports
- wp_plugin_inventory
- wp_plugin_delete_bulk
- wp_backup_cleanup
- wc_product_import
- wc_product_delete_bulk
- wc_stock_fix
- wc_test_orders
- wc_update_order_billing
- wc_update_paypal_email
- wp_update_user

Destructive actions should require an explicit confirmation token generated from a preview job.

Do not expose an arbitrary shell endpoint to the frontend.
