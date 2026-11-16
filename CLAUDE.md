# Writ: project rules

## Database migrations
- Never edit a migration file that has been applied to the database (or pushed). The database records the file's number as done and
  skips it from then on, so an edit never reaches it. Always add a new migration with a new, later number (for example one that
  drops and recreates a function).
- Only a migration that has never been applied anywhere may be changed.
- When a tool reports "migration not applied" and the database was migrated, check the object itself first (for example the
  function's signature in `pg_proc`): it may exist in an older form.
