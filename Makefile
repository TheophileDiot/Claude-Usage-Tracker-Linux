UUID := claude-usage-tracker@theophilediot.github.io

.PHONY: test pack

test:
	gjs -m tests/test-usage.js
	node tests/test-statusline.js
	glib-compile-schemas --strict schemas
	gjs -m tests/test-skin.js
	glib-compile-schemas --strict --dry-run schemas

pack: test
	mkdir -p dist
	gnome-extensions pack --force --out-dir=dist \
		--schema=schemas/org.gnome.shell.extensions.claude-usage-tracker.gschema.xml \
		--extra-source=usage.js \
		--extra-source=skin.js \
		--extra-source=statusline.js \
		--extra-source=claude-usage.svg \
		--extra-source=LICENSE \
		--extra-source=NOTICE .
