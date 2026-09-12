# ananana.py – résolution silencieuse du Turnstile
import time
import random


def draw_click_dot(page, x: float, y: float, color: str = "red", size: int = 12):
    """
    Affiche un point coloré à l'écran à la position du clic (visible sur la vidéo).
    Disparaît automatiquement après 1.5s.
    """
    try:
        page.evaluate(f"""() => {{
            const dot = document.createElement('div');
            dot.style.cssText = `
                position: fixed;
                left: {x - size//2}px;
                top: {y - size//2}px;
                width: {size}px;
                height: {size}px;
                background: {color};
                border: 2px solid white;
                border-radius: 50%;
                z-index: 999999;
                pointer-events: none;
                box-shadow: 0 0 6px rgba(0,0,0,0.6);
            `;
            document.body.appendChild(dot);
            setTimeout(() => dot.remove(), 1500);
        }}""")
    except Exception:
        pass


def move_mouse_to(page, x: float, y: float):
    """Mouvement souris humanisé via courbe de Bézier quadratique."""
    try:
        start = page.evaluate("() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 })")
    except Exception:
        start = {"x": x - 100, "y": y - 100}

    steps = random.randint(15, 25)
    for i in range(1, steps + 1):
        t = i / steps
        cp = {
            "x": start["x"] + random.uniform(-80, 80),
            "y": start["y"] + random.uniform(-80, 80),
        }
        nx = (1 - t) ** 2 * start["x"] + 2 * (1 - t) * t * cp["x"] + t**2 * x
        ny = (1 - t) ** 2 * start["y"] + 2 * (1 - t) * t * cp["y"] + t**2 * y
        page.mouse.move(nx, ny)
        time.sleep(random.uniform(0.010, 0.020))


def human_click(page, x: float, y: float, color: str = "red"):
    """
    Déplace la souris vers (x, y) de façon humanisée,
    affiche un point rouge, puis clique.
    """
    move_mouse_to(page, x, y)
    draw_click_dot(page, x, y, color=color)
    time.sleep(random.uniform(0.2, 0.5))
    page.mouse.click(x, y)


def check_turnstile_token(page) -> bool:
    """
    Vérifie si le token Turnstile est présent dans la page principale.
    Vérifie uniquement la valeur réelle de l'input (longueur > 20).
    """
    try:
        val = page.evaluate("""() => {
            const input = document.querySelector('input[name="cf-turnstile-response"]');
            if (input && input.value && input.value.length > 20) return true;
            return false;
        }""")
        return bool(val)
    except Exception:
        return False


def find_turnstile_iframe_box(page, wait_seconds: int = 10):
    """
    Cherche le bounding box de l'iframe Turnstile directement
    dans le DOM de la page principale (pas cross-origin).
    Retourne le bounding box dict ou None.
    """
    # Sélecteurs pour trouver l'iframe dans la page principale
    iframe_selectors = [
        "iframe[src*='challenges.cloudflare.com']",
        "iframe[src*='turnstile']",
        "iframe[title*='Widget']",
        "iframe[title*='widget']",
        "iframe[title*='Turnstile']",
        ".cf-turnstile iframe",
        "[data-sitekey] iframe",
    ]

    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        # Méthode 1 : via sélecteurs CSS dans le DOM principal
        for sel in iframe_selectors:
            try:
                elements = page.query_selector_all(sel)
                for el in elements:
                    src = el.get_attribute("src") or ""
                    if "challenges.cloudflare.com" in src or "turnstile" in src.lower():
                        box = el.bounding_box()
                        if box and box['width'] > 0 and box['height'] > 0:
                            print(f"✅ Iframe Turnstile trouvé [{sel}] "
                                  f"→ pos=({box['x']:.0f},{box['y']:.0f}) "
                                  f"size={box['width']:.0f}x{box['height']:.0f}")
                            return box
            except Exception:
                continue

        # Méthode 2 : via page.frames → frame_element()
        for frame in page.frames:
            if "challenges.cloudflare.com" in frame.url:
                try:
                    frame_el = frame.frame_element()
                    box = frame_el.bounding_box()
                    if box and box['width'] > 0 and box['height'] > 0:
                        print(f"✅ Iframe Turnstile trouvé via frame_element() "
                              f"→ pos=({box['x']:.0f},{box['y']:.0f}) "
                              f"size={box['width']:.0f}x{box['height']:.0f}")
                        return box
                except Exception as e:
                    print(f"⚠️ frame_element() échoué : {e}")
                    continue

        time.sleep(0.5)

    print("⚠️ Iframe Turnstile introuvable après timeout")
    return None


def click_turnstile_checkbox(page) -> bool:
    """
    Clique sur la checkbox Turnstile en ciblant l'iframe
    depuis le DOM principal (contourne le cross-origin).
    La checkbox est toujours dans le coin gauche de l'iframe.
    """
    try:
        box = find_turnstile_iframe_box(page, wait_seconds=10)

        if not box:
            return False

        # La checkbox Turnstile est dans le coin gauche de l'iframe
        # x = left + 24px (centre de la checkbox ~24px depuis le bord gauche)
        # y = centre vertical de l'iframe
        checkbox_x = box['x'] + 24
        checkbox_y = box['y'] + box['height'] / 2

        print(f"🖱️ Clic checkbox Turnstile à ({checkbox_x:.0f}, {checkbox_y:.0f})")
        human_click(page, checkbox_x, checkbox_y, color="red")
        return True

    except Exception as e:
        print(f"⚠️ Erreur clic Turnstile : {e}")
        return False


def solve_turnstile(page, timeout: int = 30) -> bool:
    """
    Résout le Turnstile Cloudflare.

    Stratégie en 3 phases :
      Phase 1 (0-3s)  : token déjà présent ? (Turnstile invisible)
      Phase 2         : clic sur checkbox via bounding box de l'iframe (DOM principal)
      Phase 3 (reste) : polling du token jusqu'au timeout

    Retourne True si résolu, False sinon.
    """
    start = time.time()

    # ── Phase 1 : Turnstile invisible déjà résolu ──────────────────────────
    print("🔍 Phase 1 : vérification token Turnstile silencieux...")
    while time.time() - start < 3:
        if check_turnstile_token(page):
            print("✅ Turnstile résolu automatiquement (mode invisible)")
            return True
        time.sleep(0.5)

    # ── Phase 2 : clic via coordonnées iframe ─────────────────────────────
    print("🔍 Phase 2 : clic sur checkbox Turnstile (coordonnées iframe)...")
    clicked = click_turnstile_checkbox(page)

    if not clicked:
        print("⚠️ Clic Turnstile impossible, passage direct au polling...")

    # ── Phase 3 : polling jusqu'au timeout ────────────────────────────────
    remaining = timeout - (time.time() - start)
    print(f"🔍 Phase 3 : polling token Turnstile ({remaining:.0f}s restantes)...")

    while time.time() - start < timeout:
        if check_turnstile_token(page):
            print("✅ Turnstile résolu après clic")
            return True
        time.sleep(1)

    print(f"❌ Turnstile non résolu après {timeout}s")
    return False
