import postgres, { type Sql, type TransactionSql } from 'postgres';

export interface SqlResult<Row> {
  readonly rows: readonly Row[];
}

/** Shared parameterized SQL boundary used by application repositories. */
export interface SqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
  transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T>;
}

export interface ManagedSqlClient extends SqlClient {
  close(): Promise<void>;
}

type QueryConnection = Pick<Sql, 'unsafe'>;

const query = async <Row extends Record<string, unknown> = Record<string, unknown>>(
  connection: QueryConnection,
  statement: string,
  values?: readonly unknown[],
): Promise<SqlResult<Row>> => ({
  // The statement is repository-owned static SQL. Values remain separately bound.
  rows: await (values === undefined ? connection.unsafe(statement) : connection.unsafe(statement, values as never[])) as Row[],
});

const wrapTransaction = (connection: TransactionSql): SqlClient => ({
  query: (statement, values) => query(connection, statement, values),
  transaction: async <T>(operation: (client: SqlClient) => Promise<T>): Promise<T> =>
    connection.savepoint((nested) => operation(wrapTransaction(nested))) as Promise<T>,
});

const wrap = (connection: Sql): SqlClient => ({
  query: (statement, values) => query(connection, statement, values),
  transaction: async <T>(operation: (client: SqlClient) => Promise<T>): Promise<T> =>
    connection.begin((transaction) => operation(wrapTransaction(transaction))) as Promise<T>,
});

export function createPostgresClient(databaseUrl: string): ManagedSqlClient {
  const connection = postgres(databaseUrl, { max: 10, prepare: true });
  const client = wrap(connection);
  return {
    ...client,
    close: async () => connection.end({ timeout: 5 }),
  };
}
