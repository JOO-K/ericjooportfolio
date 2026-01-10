// fish_outline_stagger.jsx
// After Effects script to auto-create shape outlines from fish layers (via mask/auto-trace),
// add stroke + wiggle + trim paths, and stagger each by STAGGER seconds.
// Drop into File > Scripts > Run Script File...

(function outlineFishStagger() {
    // ---------- CONFIG ----------
    var STAGGER = 0.3;      // seconds between each fish starting
    var DRAW_DUR = 1.2;     // seconds duration of the trim-draw animation
    var STROKE_WIDTH = 6;   // default stroke width
    var STROKE_COLOR = [0.0, 0.85, 1.0]; // RGB normalized (0..1) - cyan-ish
    var WIGGLE_SIZE = 6;    // wiggle path size
    var WIGGLE_DETAIL = 3;  // wiggle path detail
    var START_OFFSET = 0.0; // extra offset (seconds) before first animation starts
    // ----------------------------

    app.beginUndoGroup("Fish Outline Stagger");

    var comp = app.project.activeItem;
    if (!(comp && comp instanceof CompItem)) {
        alert("Please open a composition and try again.");
        app.endUndoGroup();
        return;
    }

    // collect target layers: selected or all
    var layers = [];
    if (comp.selectedLayers.length > 0) {
        layers = comp.selectedLayers;
    } else {
        for (var li = 1; li <= comp.numLayers; li++) {
            layers.push(comp.layer(li));
        }
    }

    if (layers.length === 0) {
        alert("No layers found in the composition.");
        app.endUndoGroup();
        return;
    }

    // helper: check if layer has at least one mask with non-empty path
    function layerHasMask(lay) {
        try {
            var masks = lay.property("Masks");
            if (masks && masks.numProperties > 0) {
                // find first mask with a non-empty shape
                for (var m = 1; m <= masks.numProperties; m++) {
                    var maskShapeProp = masks.property(m).property("maskShape");
                    if (maskShapeProp && maskShapeProp.numKeys >= 0) {
                        var shp = maskShapeProp.value;
                        // naive check that path has points
                        if (shp && shp.vertices && shp.vertices.length > 0) return true;
                    }
                }
            }
        } catch (e) {}
        return false;
    }

    // For every source layer, ensure there's a mask (auto-trace if needed),
    // then create a shape layer using the top mask path.
    for (var i = 0; i < layers.length; i++) {
        try {
            var src = layers[i];

            // only process AV layers (skip cameras, lights)
            if (!(src instanceof AVLayer)) {
                continue;
            }

            // lock check
            if (src.locked) {
                // skip locked layers
                continue;
            }

            // make sure there is at least one mask
            if (!layerHasMask(src)) {
                // Try auto-trace (may create mask(s)). wrap in try/catch because the method can sometimes fail
                try {
                    // layer.autoTrace exists in AE scripting and will run Auto-trace with defaults
                    if (typeof src.autoTrace === "function") {
                        src.autoTrace();
                    } else {
                        // fallback: run menu Auto-trace (may show dialog depending on version)
                        var autoTraceCmd = app.findMenuCommandId("Auto-trace...");
                        if (autoTraceCmd !== 0 && autoTraceCmd !== -1) {
                            // select layer and invoke menu command
                            comp.selectedLayers = [src];
                            app.executeCommand(autoTraceCmd);
                        } else {
                            // if we can't auto-trace programmatically, skip this layer
                            $.writeln("Warning: Auto-trace not available on this AE build. Layer skipped: " + src.name);
                            continue;
                        }
                    }
                } catch (atErr) {
                    $.writeln("Auto-trace failed for layer: " + src.name + " — " + atErr.toString());
                    // continue anyway — if no mask exists it'll be skipped
                }
            }

            // re-check masks
            if (!layerHasMask(src)) {
                // if still no masks, skip this layer
                $.writeln("No mask created/found for layer: " + src.name + ". Skipping.");
                continue;
            }

            // pick the first mask we can find
            var masksProp = src.property("Masks");
            var maskIndex = null;
            for (var mm = 1; mm <= masksProp.numProperties; mm++) {
                var ms = masksProp.property(mm).property("maskShape");
                if (ms) {
                    var msVal = ms.value;
                    if (msVal && msVal.vertices && msVal.vertices.length > 0) {
                        maskIndex = mm;
                        break;
                    }
                }
            }
            if (maskIndex === null) {
                $.writeln("Couldn't find usable mask for layer: " + src.name + ". Skipping.");
                continue;
            }

            var maskShapeProp = masksProp.property(maskIndex).property("maskShape");
            var maskShapeValue = maskShapeProp.value;

            // Create a new shape layer and transfer the mask path into a shape path
            var shapeLayer = comp.layers.addShape();
            shapeLayer.name = src.name + " - Outline";
            // position shape layer at same comp time as source
            // we'll set the startTime so the trim animation lines up
            var layerStart = comp.time + START_OFFSET + i * STAGGER;
            // set startTime so inPoint corresponds to our desired animation start
            shapeLayer.startTime = layerStart;

            // Build shape group: Group > Contents > Path + Stroke + Wiggle + Trim
            var rootContents = shapeLayer.property("ADBE Root Vectors Group");

            // Add a group
            var group = rootContents.addProperty("ADBE Vector Group");

            // Add a Path object inside group and set it to the mask path
            var groupContents = group.property("ADBE Vectors Group");
            var pathProp = groupContents.addProperty("ADBE Vector Shape - Group"); // path
            pathProp.property("ADBE Vector Shape").setValue(maskShapeValue);

            // Add Stroke
            var stroke = groupContents.addProperty("ADBE Vector Graphic - Stroke");
            if (stroke) {
                try {
                    stroke.property("ADBE Vector Stroke Color").setValue(STROKE_COLOR);
                    stroke.property("ADBE Vector Stroke Width").setValue(STROKE_WIDTH);
                    // stroke line cap / join - set to round if available
                    try { stroke.property("ADBE Vector Stroke Line Cap").setValue(2); } catch (e) {}
                    try { stroke.property("ADBE Vector Stroke Line Join").setValue(2); } catch (e) {}
                } catch (e) {}
            }

            // Add Wiggle Paths for organic jitter
            var wiggle = groupContents.addProperty("ADBE Vector Filter - Wiggle");
            if (wiggle) {
                try {
                    // property names for wiggle path
                    wiggle.property("ADBE Vector Wiggle Size").setValue(WIGGLE_SIZE);
                    wiggle.property("ADBE Vector Wiggle Detail").setValue(WIGGLE_DETAIL);
                    // speed of wiggle -> give each a slightly different phase
                    var speedRand = 0.5 + Math.random() * 1.2;
                    wiggle.property("ADBE Vector Wiggle Speed").setValue(speedRand);
                } catch (e) {}
            }

            // Add Trim Paths
            var trim = groupContents.addProperty("ADBE Vector Filter - Trim");
            if (trim) {
                try {
                    // Trim properties
                    var trimStartProp = trim.property("ADBE Vector Trim Start");
                    var trimEndProp = trim.property("ADBE Vector Trim End");
                    var trimOffsetProp = trim.property("ADBE Vector Trim Offset");

                    // Clear any existing keys just in case
                    try {
                        while (trimStartProp.numKeys) trimStartProp.removeKey(1);
                        while (trimEndProp.numKeys) trimEndProp.removeKey(1);
                        while (trimOffsetProp.numKeys) trimOffsetProp.removeKey(1);
                    } catch (e) {}

                    // Animation times
                    var t0 = layerStart;
                    var t1 = t0 + DRAW_DUR;

                    // start at 0 end at 0 at t0 (ensure invisible before start)
                    trimStartProp.setValueAtTime(t0 - 0.01, 0);
                    trimEndProp.setValueAtTime(t0 - 0.01, 0);

                    // at t0, start the draw: start remains 0, end animates to 100
                    trimStartProp.setValueAtTime(t0, 0);
                    trimEndProp.setValueAtTime(t0, 0);

                    // at t1 end = 100
                    trimEndProp.setValueAtTime(t1, 100);

                    // Add easing for nicer feel
                    // get newly added keys index
                    try {
                        var kStartIndex = trimStartProp.nearestKeyIndex(t0);
                        var kEnd0Index = trimEndProp.nearestKeyIndex(t0);
                        var kEnd1Index = trimEndProp.nearestKeyIndex(t1);

                        // ease
                        var easeIn = new KeyframeEase(0.0, 20.0);
                        var easeOut = new KeyframeEase(0.0, 30.0);
                        try { trimEndProp.setTemporalEaseAtKey(kEnd1Index, [easeOut], [easeOut]); } catch (e) {}
                        try { trimEndProp.setTemporalEaseAtKey(kEnd0Index, [easeIn], [easeIn]); } catch (e) {}
                    } catch (e) {}

                    // optional small offset to animate thickness/other properties could be added here
                } catch (e) {
                    $.writeln("Trim creation error for " + shapeLayer.name + ": " + e.toString());
                }
            }

            // SUBTLE: add a fast scale pop at start to make it pop-in; add expression to keep it subtle
            try {
                var scaleProp = shapeLayer.property("ADBE Transform Group").property("ADBE Scale");
                // set initial keyframe so pop happens around t0
                var popStart = layerStart - 0.02;
                var popEnd = layerStart + Math.min(0.18, DRAW_DUR * 0.25);
                scaleProp.setValueAtTime(popStart, [95,95,100]);
                scaleProp.setValueAtTime(popEnd, [100,100,100]);
                // set easing
                try {
                    var si = scaleProp.nearestKeyIndex(popStart);
                    var ei = scaleProp.nearestKeyIndex(popEnd);
                    var easeA = new KeyframeEase(0, 85);
                    var easeB = new KeyframeEase(0, 85);
                    scaleProp.setTemporalEaseAtKey(si, [easeA, easeA], [easeA, easeA]);
                    scaleProp.setTemporalEaseAtKey(ei, [easeB, easeB], [easeB, easeB]);
                } catch (e) {}
            } catch (e) {}

            // make sure shape layer is above the source for readability
            try {
                shapeLayer.moveBefore(src);
            } catch (e) {}

            // set the shape layer's parent to null (safe) and set blending mode if you like
            try {
                // Uncomment if you want additive look:
                // shapeLayer.blendingMode = BlendingMode.ADD;
            } catch (e) {}

        } catch (err) {
            $.writeln("Error processing layer index " + i + ": " + err.toString());
        }
    } // end for each layer

    app.endUndoGroup();
    alert("Done — outline shape layers created and staggered by " + STAGGER + "s.\n\nTip: if your layers are PNG/raster and the trace didn't work perfectly, try running Auto-trace manually with adjusted tolerance, then re-run the script for more precise outlines.");
})();
