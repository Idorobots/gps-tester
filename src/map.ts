import L from "leaflet";
import "leaflet/dist/leaflet.css";

export interface GpsMap {
  update(lat: number, lon: number, hasFix: boolean): void;
}

export function createGpsMap(container: HTMLElement, followCheckbox: HTMLInputElement): GpsMap {
  const map = L.map(container, { zoomControl: true });
  map.setView([0, 0], 2);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  const icon = L.divIcon({
    className: "gps-marker",
    html: '<div class="gps-dot"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });

  let marker: L.Marker | null = null;
  let follow = followCheckbox.checked;

  followCheckbox.addEventListener("change", () => {
    follow = followCheckbox.checked;
  });

  map.on("dragstart", () => {
    if (follow) {
      follow = false;
      followCheckbox.checked = false;
    }
  });

  function update(lat: number, lon: number, hasFix: boolean): void {
    if (!hasFix) return;
    const ll = L.latLng(lat, lon);
    if (!marker) {
      marker = L.marker(ll, { icon }).addTo(map);
    } else {
      marker.setLatLng(ll);
    }
    if (follow) {
      const zoom = Math.max(map.getZoom(), 14);
      map.setView(ll, zoom);
    }
  }

  return { update };
}