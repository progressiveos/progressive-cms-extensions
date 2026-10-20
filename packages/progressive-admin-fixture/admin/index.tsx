// Admin UI contributions (ADR-0017 S6 UI contract fixture): registers a nav
// section, a route with a screen, translations and an asset — everything
// through the contribution API, nothing imported by the Admin core.
import type { AdminContributionApi } from "@pcms/extensions";
import fixtureIcon from "./fixture-icon.svg";

export function registerAdminContributions(api: AdminContributionApi): void {
  api.translations({
    ru: {
      "admin_fixture.nav": "UI-фикстура",
      "admin_fixture.title": "Экран UI-фикстуры",
      "admin_fixture.greeting": "Экран из внешнего пакета: навигация, переводы и ассет подключены через Extension SDK.",
    },
    en: {
      "admin_fixture.nav": "UI fixture",
      "admin_fixture.title": "UI fixture screen",
      "admin_fixture.greeting": "A screen from an external package: navigation, translations and asset wired through the Extension SDK.",
    },
  });
  api.nav({
    id: "admin-fixture",
    title: "admin_fixture.nav",
    items: [
      {
        id: "admin-fixture-slot",
        title: "admin_fixture.nav",
        path: "admin-fixture",
      },
    ],
  });
  api.route({
    pattern: "admin-fixture",
    title: "admin_fixture.title",
    load: async () => ({
      default: function FixtureScreen() {
        return (
          <div data-testid="admin-fixture-screen" style={{ display: "grid", gap: 12 }}>
            <h1 data-testid="admin-fixture-heading">{api.t("admin_fixture.title")}</h1>
            <p>{api.t("admin_fixture.greeting")}</p>
            <img src={fixtureIcon} alt="" width={16} height={16} />
          </div>
        );
      },
    }),
  });
}
