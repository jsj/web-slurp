# Icon rendering

`AppIcon.icon/Assets/straw.png` preserves the original artwork. `icon.png` is the Default 1024px export for the README.

Rendered with `/Applications/Xcode-beta.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool`, design generation 27.

The render-app-icon skill command:

```sh
~/.agents/skills/render-app-icon/scripts/render_icon_previews.sh .README/AppIcon.icon /tmp/web-slurp-icon-smaller 27
```

Inspected Default, Dark, TintedLight, and TintedDark at 29, 60, 120, and 1024 pixels. All rendered successfully. Default and Dark preserve the original colors. Apple applies the selected tint to the tinted appearances.

The artwork layer uses a scale of 0.9 for more space around the straw.
