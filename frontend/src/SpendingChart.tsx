import React, { useState } from "react";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { CategorySpend } from "./types";

type SpendingChartProps = {
  data: CategorySpend[];
};

type CustomTooltipProps = {
  active?: boolean;
  payload?: Array<{
    payload: CategorySpend;
  }>;
};

const formatMoney = (value: number | null | undefined) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value || 0));

function CustomTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;

  return (
    <div
      style={{
        background: "#161e14",
        border: "1px solid #253325",
        borderRadius: "8px",
        padding: "10px 14px",
      }}
    >
      <div
        style={{
          fontSize: "13px",
          fontWeight: 600,
          color: "#e8f4e8",
          marginBottom: "4px",
        }}
      >
        {d.category}
      </div>
      <div
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: "14px",
          color: "#00e87a",
        }}
      >
        {formatMoney(d.amount)} ({d.percentage}%)
      </div>
    </div>
  );
}

export default function SpendingChart({ data }: SpendingChartProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  if (!Array.isArray(data) || data.length === 0) {
    return (
      <div
        style={{
          color: "#5a7a5a",
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: "13px",
        }}
      >
        No spending data available yet.
      </div>
    );
  }

  const totalSpent = data.reduce((sum, item) => sum + item.amount, 0);

  return (
    <div
      style={{
        display: "flex",
        gap: "40px",
        alignItems: "flex-start",
        flexWrap: "wrap",
      }}
    >
      {/* ── Donut chart ── */}
      <div style={{ width: 260, flexShrink: 0 }}>
        <ResponsiveContainer width={260} height={260}>
          <PieChart>
            <Pie
              data={data}
              dataKey="amount"
              nameKey="category"
              cx="50%"
              cy="50%"
              innerRadius={72}
              outerRadius={110}
              paddingAngle={2}
              stroke="none"
              onMouseEnter={(_, index: number) => setActiveIndex(index)}
              onMouseLeave={() => setActiveIndex(null)}
            >
              {data.map((d, index) => (
                <Cell
                  key={d.category}
                  fill={d.color}
                  opacity={activeIndex === null || activeIndex === index ? 1 : 0.35}
                />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
          </PieChart>
        </ResponsiveContainer>

        {/* Center label */}
        <div
          style={{
            textAlign: "center",
            marginTop: "-148px",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: "11px",
              color: "#5a7a5a",
              marginBottom: "4px",
            }}
          >
            total spent
          </div>
          <div
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: "20px",
              fontWeight: 500,
              color: "#e8f4e8",
            }}
          >
            {formatMoney(totalSpent)}
          </div>
        </div>

        <div style={{ height: "110px" }} />
      </div>

      {/* ── Category list ── */}
      <div style={{ flex: 1, minWidth: 220, paddingTop: "8px" }}>
        {data.map((d, index) => {
          const isActive = activeIndex === index;

          return (
            <div
              key={d.category}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseLeave={() => setActiveIndex(null)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                marginBottom: "12px",
                opacity: activeIndex === null || isActive ? 1 : 0.4,
                transition: "opacity 0.15s",
              }}
            >
              <div
                style={{
                  width: "10px",
                  height: "10px",
                  borderRadius: "50%",
                  background: d.color,
                  flexShrink: 0,
                }}
              />
              <div
                style={{
                  fontSize: "13px",
                  color: "#d4e8d4",
                  flex: 1,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {d.category}
              </div>
              <div
                style={{
                  flex: 2,
                  height: "3px",
                  background: "#1e2b1e",
                  borderRadius: "2px",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${d.percentage}%`,
                    height: "100%",
                    background: d.color,
                    borderRadius: "2px",
                  }}
                />
              </div>
              <div
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: "12px",
                  color: "#5a7a5a",
                  minWidth: "72px",
                  textAlign: "right",
                }}
              >
                {formatMoney(d.amount)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
