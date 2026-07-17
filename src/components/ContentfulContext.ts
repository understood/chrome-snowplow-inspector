import { createContext } from "preact";

import type { ContentResolver } from "../ts/contentful";

export const ContentfulContext = createContext<ContentResolver | null>(null);
