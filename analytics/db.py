import psycopg2
import pandas as pd

def get_connection():
    return psycopg2.connect(
        host="aws-1-us-east-2.pooler.supabase.com",
        port=6543,
        dbname="postgres",
        user="postgres.tppviuuhbyqwskebigdx",
        password="WaMsZEGu7j8CJ",
        sslmode="require",
        connect_timeout=10
    )

def load_transactions(months: int = 24) -> pd.DataFrame:
    sql = """
        SELECT
            id, date, amount::float AS amount, name,
            "cleanName" AS clean_name, "merchantName" AS merchant_name,
            "categoryPrimary" AS category_primary,
            "categoryDetailed" AS category_detailed,
            pending, "accountId" AS account_id
        FROM "Transaction"
        WHERE "deletedAt" IS NULL
          AND pending = false
          AND amount > 0
          AND date >= NOW() - INTERVAL '%s months'
        ORDER BY date DESC
    """
    conn = get_connection()
    try:
        df = pd.read_sql(sql, conn, params=(months,))
        df["date"]  = pd.to_datetime(df["date"])
        df["month"] = df["date"].dt.to_period("M")
        df["year"]  = df["date"].dt.year
        return df
    finally:
        conn.close()

if __name__ == "__main__":
    df = load_transactions()
    print(f"Loaded {len(df)} transactions")
    print(f"Date range: {df.date.min().date()} to {df.date.max().date()}")
    print(f"Columns: {list(df.columns)}")