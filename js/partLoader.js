(function() {
  if (!document.querySelector('#navWrapper')) {
    $.get("./components/navigation.html", function(data) {
      $("#navigation").replaceWith(data);
      console.log("Navigation loaded");
    });
  }
  if (!document.querySelector('#archivemenu')) {
    $.get("./components/archivemenu.html", function(data) {
      $("#archivemenu").replaceWith(data);
      console.log("Archivemenu loaded");
    });
  }
  if (!document.querySelector('#homepageSlide')) {
    $.get("./components/homepageSlide.html", function(data) {
      $("#homepageSlide").replaceWith(data);
      console.log("HomepageSlide loaded");
      $(document).trigger("homepageSlideLoaded");
    });
  } else {
    console.log("HomepageSlide already loaded, skipping");
    $(document).trigger("homepageSlideLoaded");
  }
})();