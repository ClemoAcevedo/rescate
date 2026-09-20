-- Up Migration

CREATE TABLE public.migration_tool_test (
  id integer PRIMARY KEY
);

-- Down Migration

DROP TABLE public.migration_tool_test;
