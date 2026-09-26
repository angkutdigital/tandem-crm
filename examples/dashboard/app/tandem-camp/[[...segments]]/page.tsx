// The entire host wiring a real deployment needs for Camp: one side-effect
// import of the config module (must run before CampRootPage renders --
// see tandem-camp.config.ts and mountTandemCamp's own doc comment) and one
// re-export of CampRootPage with this route's own mount path.
import "../../../tandem-camp.config";
import { CampRootPage } from "tandem-camp";

export default function Page(props: {
  params: Promise<{ segments?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <CampRootPage {...props} basePath="/tandem-camp" />;
}
