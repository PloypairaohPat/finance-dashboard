import React, { useState, useEffect } from "react";
import { useAuth } from "@clerk/clerk-react";
import { RecurringData, RecurringStream } from "./types";
import { API_URL } from "./config"

const fmt = (n: number | null | undefined) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(n ?? 0));

const freqLabel = (f: string | null | undefined) =>
  ({
    WEEKLY: "weekly",
    BIWEEKLY: "every 2 weeks",
    SEMI_MONTHLY: "twice a month",
    MONTHLY: "monthly",
    ANNUALLY: "annually",
  } as Record<string, string>)[f ?? ""] || f?.toLowerCase() || "recurring";

type StreamRowProps = {
  stream: RecurringStream;
  type: "outflow" | "inflow";
};

function StreamRow({ stream, type }: StreamRowProps) {
  const isIncome = type === "inflow";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 0",
        borderBottom: "1px solid #1a1a1a",
      }}
    >
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontSize: "14px",
            fontWeight: 600,
            color: "#d0cdc8",
            marginBottom: "2px",
          }}
        >
          {stream.merchantName}
        </div>
        <div
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: "11px",
            color: "#555",
          }}
        >
          {freqLabel(stream.frequency)} · last {stream.lastDate}
        </div>
      </div>

      <div style={{ textAlign: "right" }}>
        <div
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: "15px",
            fontWeight: 500,
            color: isIncome ? "#00e5a0" : "#f0ede8",
          }}
        >
          {isIncome ? "+" : "-"}
          {fmt(stream.averageAmount)}
        </div>
        {stream.status === "EARLY_DETECTION" && (
          <div
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: "10px",
              color: "#f0a030",
              marginTop: "2px",
            }}
          >
            detecting…
          </div>
        )}
      </div>
    </div>
  );
}

export default function RecurringCard() {
  const [data, setData] = useState<RecurringData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { getToken } = useAuth();

  const load = async () => {
    setLoading(true);
    setError(null);

    try {
      const token = await getToken();
      const r = await fetch(`${API_URL}/recurring`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d: RecurringData & { error?: string } = await r.json();
      if (d.error) throw new Error(d.error);
      setData(d);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return (
      <div
        style={{
          color: "#5a7a5a",
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: "13px",
          padding: "20px 0",
        }}
      >
        Analysing recurring transactions…
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          color: "#ff5555",
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: "13px",
        }}
      >
        ⚠ {error}
        <button
          onClick={load}
          style={{
            marginLeft: "12px",
            background: "transparent",
            border: "1px solid #555",
            color: "#888",
            padding: "4px 10px",
            borderRadius: "4px",
            cursor: "pointer",
            fontSize: "11px",
            fontFamily: "'IBM Plex Mono', monospace",
          }}
        >
          retry
        </button>
      </div>
    );
  }

  if (!data || (data.outflow.length === 0 && data.inflow.length === 0)) {
    return (
      <div
        style={{
          color: "#5a7a5a",
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: "13px",
        }}
      >
        No recurring streams detected yet — sync more transaction history first.
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "20px",
          marginBottom: "28px",
          padding: "16px 20px",
          background: "#111",
          border: "1px solid #1e1e1e",
          borderRadius: "10px",
        }}
      >
        <div>
          <div
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: "11px",
              color: "#555",
              marginBottom: "4px",
            }}
          >
            monthly subscriptions
          </div>
          <div
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: "22px",
              fontWeight: 500,
              color: "#ff6b6b",
            }}
          >
            -{fmt(data.monthlyOutflow)}
          </div>
        </div>

        <div>
          <div
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: "11px",
              color: "#555",
              marginBottom: "4px",
            }}
          >
            recurring streams
          </div>
          <div
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: "22px",
              fontWeight: 500,
              color: "#f0ede8",
            }}
          >
            {data.outflow.length + data.inflow.length}
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "32px" }}>
        {data.outflow.length > 0 && (
          <div>
            <div
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: "10px",
                letterSpacing: ".1em",
                textTransform: "uppercase",
                color: "#555",
                marginBottom: "12px",
              }}
            >
              Subscriptions &amp; bills · {data.outflow.length}
            </div>
            {data.outflow.map((s, i) => (
              <StreamRow key={i} stream={s} type="outflow" />
            ))}
          </div>
        )}

        {data.inflow.length > 0 && (
          <div>
            <div
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: "10px",
                letterSpacing: ".1em",
                textTransform: "uppercase",
                color: "#555",
                marginBottom: "12px",
              }}
            >
              Income streams · {data.inflow.length}
            </div>
            {data.inflow.map((s, i) => (
              <StreamRow key={i} stream={s} type="inflow" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
