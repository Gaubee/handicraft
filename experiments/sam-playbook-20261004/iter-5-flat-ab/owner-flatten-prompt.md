# Owner 扁平化辅助图提示词（2026-10-04，逐字冻结——产品化时原样使用）

```
Edit the input image with the following strict priority:

1. PRESERVE THE ORIGINAL SHAPES AND CONTOURS EXACTLY.

   * Do not redraw, reshape, deform, smooth, expand, shrink, or reinterpret any object.
   * Keep every object's original outer boundary, silhouette, edge position, proportion, and relative position unchanged.
   * Preserve small contour details, irregularities, corners, curves, notches, and protrusions.
   * The original geometry is the source of truth.

2. FLATTEN THE VISUAL APPEARANCE INSIDE THE ORIGINAL CONTOURS.

   * Remove complex gradients.
   * Remove realistic lighting and shadows.
   * Remove highlights, reflections, gloss, and photographic shading.
   * Reduce complex color variations into a small number of clean, flat color regions.
   * Replace painterly brushwork with simple, uniform flat fills.
   * Preserve the dominant base color of each region.

3. REMOVE DECORATIVE SURFACE DETAILS.

   * Remove jewelry, gemstones, rhinestones, beads, sequins, glitter, embroidery, decorative particles, and similar surface ornaments.
   * Remove small reflective or shiny objects that are attached to or placed on top of a larger object.
   * Treat these details as visual decoration rather than independent objects.
   * Merge them into the underlying surface color whenever they do not affect the object's outer contour.

   Examples:

   * Yellow hair with yellow gemstones → render as continuous flat yellow hair; remove the gemstones.
   * White clothing with white gemstones → render as continuous flat white clothing; remove the gemstones.
   * Red fabric with red sequins → render as continuous flat red fabric; remove the sequins.
   * Skin with small highlights or reflective spots → preserve the skin as a flat skin-color region.
   * A colored surface covered with small same-color decorative elements → merge them into the underlying color.

4. DISTINGUISH STRUCTURE FROM SURFACE DECORATION.

   * Preserve features that define the actual shape or silhouette of an object.
   * Remove details that merely decorate, texture, reflect, or embellish an existing surface.
   * Do not preserve a gemstone, highlight, reflection, or ornament as a separate region merely because it has a visible boundary.
   * If removing a detail would change the outer contour of the main object, preserve the contour but simplify the detail inside it.

5. COLOR SIMPLIFICATION.

   * For each major region, identify its underlying/base color.
   * Use that base color as the dominant fill.
   * Small variations caused by lighting, reflections, gemstones, jewelry, texture, or surface decoration should be absorbed into the underlying region.
   * Keep meaningful color boundaries between different actual objects.

6. STRICT GEOMETRY CONSTRAINT.
   The original image is the geometric source of truth.
   Treat the existing contours as fixed masks.
   Only simplify the appearance and internal visual information inside those masks.
   Never alter an object's silhouette or outer boundary.

7. NO CREATIVE REDESIGN.

   * Do not add objects.
   * Do not remove actual objects.
   * Do not change object positions.
   * Do not change proportions.
   * Do not change the camera angle or perspective.
   * Do not invent missing geometry.
   * Do not cartoonize or redesign the image.
   * Do not vectorize the image into a new interpretation.

Contour preservation has absolute priority over visual quality.
If flattening or removing a decorative detail would require changing the original contour, preserve the original contour and sacrifice the simplification.

The final image should look like a clean, flat-color version of the original image:
same silhouettes, same contours, same composition, same major color regions,
but with gradients, lighting, shadows, texture, jewelry, gemstones, reflections, and decorative surface details removed.
```

## 产品化语义（Owner 原话）

- 触发条件：流程发现原图不是扁平化的风格
- 输入输出：原图 →（本提示词）→「辅助图」；**全层面抠图面向辅助图**
- 导出：钻的布局 + **原图**（辅助图不显示）
