/* IVI — landing page interactions */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Year ---------- */
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  /* ---------- Header state ---------- */
  var header = document.querySelector(".site-header");
  var nav = document.getElementById("nav");
  var navToggle = document.getElementById("navToggle");

  function onScroll() {
    if (!header) return;
    header.classList.toggle("is-scrolled", window.scrollY > 12);
  }
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---------- Mobile nav ---------- */
  function setMenu(open) {
    if (!nav || !navToggle) return;
    nav.classList.toggle("is-open", open);
    header.classList.toggle("menu-open", open);
    document.body.classList.toggle("nav-open", open);
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  }

  if (navToggle && nav) {
    navToggle.addEventListener("click", function () {
      setMenu(!nav.classList.contains("is-open"));
    });

    nav.addEventListener("click", function (event) {
      if (event.target.closest("a")) setMenu(false);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && nav.classList.contains("is-open")) {
        setMenu(false);
        navToggle.focus();
      }
    });

    window.addEventListener("resize", function () {
      if (window.innerWidth > 900) setMenu(false);
    });
  }

  /* ---------- Reveal on scroll ---------- */
  var revealEls = document.querySelectorAll("[data-reveal]");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealEls.forEach(function (el) { el.classList.add("is-visible"); });
  } else {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    revealEls.forEach(function (el) { revealObserver.observe(el); });
  }

  /* ---------- Chart animation ---------- */
  var auditCard = document.querySelector(".audit-card");
  if (auditCard) {
    if (reduceMotion || !("IntersectionObserver" in window)) {
      auditCard.classList.add("is-live");
    } else {
      var chartObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            auditCard.classList.add("is-live");
            chartObserver.disconnect();
          }
        });
      }, { threshold: 0.35 });
      chartObserver.observe(auditCard);
    }
  }

  /* ---------- FAQ accordion ---------- */
  var faqItems = Array.prototype.slice.call(document.querySelectorAll(".faq-item"));

  function setFaq(item, open) {
    var btn = item.querySelector(".faq-q");
    var panel = item.querySelector(".faq-a");
    if (!btn || !panel) return;
    item.classList.toggle("is-open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    panel.setAttribute("aria-hidden", open ? "false" : "true");
  }

  faqItems.forEach(function (item) {
    var btn = item.querySelector(".faq-q");
    setFaq(item, btn && btn.getAttribute("aria-expanded") === "true");

    if (!btn) return;
    btn.addEventListener("click", function () {
      var willOpen = btn.getAttribute("aria-expanded") !== "true";
      faqItems.forEach(function (other) {
        if (other !== item) setFaq(other, false);
      });
      setFaq(item, willOpen);
    });
  });

  /* ---------- Active nav link ---------- */
  var spySections = ["who", "services", "approach", "pricing", "faq"]
    .map(function (id) { return document.getElementById(id); })
    .filter(Boolean);
  var navLinks = {};
  document.querySelectorAll('.nav-list a[href^="#"]').forEach(function (link) {
    navLinks[link.getAttribute("href").slice(1)] = link;
  });

  var spyTick = false;
  function updateSpy() {
    spyTick = false;
    if (!spySections.length) return;
    var marker = window.scrollY + window.innerHeight * 0.38;
    var current = null;
    var contactSection = document.getElementById("contact");
    var contactTop = contactSection
      ? contactSection.getBoundingClientRect().top + window.scrollY
      : Infinity;

    if (marker < contactTop) {
      spySections.forEach(function (section) {
        var top = section.getBoundingClientRect().top + window.scrollY;
        if (top <= marker) current = section.id;
      });
    }

    Object.keys(navLinks).forEach(function (id) {
      navLinks[id].classList.toggle("is-active", id === current);
    });
  }

  function requestSpy() {
    if (spyTick) return;
    spyTick = true;
    window.requestAnimationFrame(updateSpy);
  }

  updateSpy();
  window.addEventListener("scroll", requestSpy, { passive: true });
  window.addEventListener("resize", requestSpy);

  /* ---------- Contact form ---------- */
  var form = document.getElementById("fitForm");
  var success = document.getElementById("formSuccess");
  var resetBtn = document.getElementById("formReset");
  var errorEl = document.getElementById("formError");
  var emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function validField(field) {
    if (!field) return true;
    var value = (field.value || "").trim();
    if (!value) return false;
    if (field.type === "email") return emailPattern.test(value);
    return true;
  }

  if (form && success) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var fields = Array.prototype.slice.call(form.querySelectorAll("[required]"));
      var firstInvalid = null;

      fields.forEach(function (field) {
        var ok = validField(field);
        field.setAttribute("aria-invalid", ok ? "false" : "true");
        if (!ok && !firstInvalid) firstInvalid = field;
      });

      if (firstInvalid) {
        if (errorEl) errorEl.hidden = false;
        firstInvalid.focus();
        return;
      }

      if (errorEl) errorEl.hidden = true;
      form.hidden = true;
      success.hidden = false;
      success.focus({ preventScroll: true });
    });

    form.addEventListener("input", function (event) {
      var field = event.target;
      if (field && field.hasAttribute("aria-invalid")) {
        field.setAttribute("aria-invalid", validField(field) ? "false" : "true");
      }
    });

    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        form.reset();
        form.querySelectorAll("[aria-invalid]").forEach(function (field) {
          field.setAttribute("aria-invalid", "false");
        });
        success.hidden = true;
        form.hidden = false;
        var first = form.querySelector("input");
        if (first) first.focus();
      });
    }
  }
})();
