import React, { useState } from "react";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

const COLORS = [
  "#00e87a",
  "#4a9eff",
  "#f0a030",
  "#a070ff",
  "#ff7070",
  "#00c4d4",
  "#ffcc44",
  "#ff8c44",
  "#c0e860",
  "#ff70c0",
];

const formatMoney = (value) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value || 0));

const formatCategoryName = (name) =>
  String(name || "")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;

  const { name, total } = payload[0].payload;

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
        {formatCategoryName(name)}
      </div>
      <div
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: "14px",
          color: "#00e87a",
        }}
      >
        {formatMoney(total)}
      </div>
    </div>
  );
}

export default function SpendingChart({ categories = [] }) {
  const [activeIndex, setActiveIndex] = useState(null);

  if (!Array.isArray(categories) || categories.length === 0) {
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

  const totalSpent = categories.reduce(
    (sum, item) => sum + Number(item.total || 0),
    0
  );

  return (
    <div
      style={{
        display: "flex",
        gap: "40px",
        alignItems: "flex-start",
        flexWrap: "wrap",
      }}
    >
      <div style={{ width: 260, flexShrink: 0 }}>
        <ResponsiveContainer width={260} height={260}>
          <PieChart>
            <Pie
              data={categories}
              dataKey="total"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={72}
              outerRadius={110}
              paddingAngle={2}
              stroke="none"
              onMouseEnter={(_, index) => setActiveIndex(index)}
              onMouseLeave={() => setActiveIndex(null)}
            >
              {categories.map((_, index) => (
                <Cell
                  key={index}
                  fill={COLORS[index % COLORS.length]}
                  opacity={
                    activeIndex === null || activeIndex === index ? 1 : 0.35
                  }
                />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
          </PieChart>
        </ResponsiveContainer>

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

      <div style={{ flex: 1, minWidth: 220, paddingTop: "8px" }}>
        {categories.map((category, index) => {
          const pct = totalSpent > 0 ? (Number(category.total || 0) / totalSpent) * 100 : 0;
          const color = COLORS[index % COLORS.length];
          const isActive = activeIndex === index;

          return (
            <div
              key={category.name}
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
                  background: color,
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
                {formatCategoryName(category.name)}
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
                    width: `${pct}%`,
                    height: "100%",
                    background: color,
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
                {formatMoney(category.total)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}