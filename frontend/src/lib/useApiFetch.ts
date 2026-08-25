import { useCallback } from "react";
import { useAuth } from "@clerk/clerk-react";
import { useDemo } from "./DemoContext";

export function useApiFetch() {
  const { getToken } = useAuth();
  const { demoMode } = useDemo();
  return useCallback(
    async (url: string, options: RequestInit = {}) => {
      const headers: Record<string, string> = {
        ...((options.headers as Record<string, string>) ?? {}),
      };
      if (demoMode) {
        headers["X-Demo-Mode"] = "1";
      } else {
        const token = await getToken();
        if (token) headers["Authorization"] = `Bearer ${token}`;
      }
      return fetch(url, { ...options, headers });
    },
    [getToken, demoMode]
  );
}
