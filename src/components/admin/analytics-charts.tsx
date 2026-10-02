'use client';

import {
  ResponsiveContainer,
  LineChart as RechartsLineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  BarChart as RechartsBarChart,
  Bar
} from 'recharts';

export function PageVisitsBarChart({ data }: { data: { path: string; visits: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <RechartsBarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="path" />
        <YAxis />
        <Tooltip />
        <Legend />
        <Bar dataKey="visits" fill="#8884d8" />
      </RechartsBarChart>
    </ResponsiveContainer>
  );
}

export function ClicksLineChart({ data }: { data: { date: string; count: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <RechartsLineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="date" />
        <YAxis allowDecimals={false} />
        <Tooltip />
        <Legend />
        <Line type="monotone" dataKey="count" stroke="#82ca9d" />
      </RechartsLineChart>
    </ResponsiveContainer>
  );
}
