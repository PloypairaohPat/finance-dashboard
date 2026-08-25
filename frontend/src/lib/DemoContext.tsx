import { createContext, useContext } from "react";

export const DemoContext = createContext<{ demoMode: boolean }>({ demoMode: false });
export const useDemo = () => useContext(DemoContext);
